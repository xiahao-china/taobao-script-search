import { createHash } from 'node:crypto';
import { TaobaoError } from '../../core/errors.js';
import { parsePrice } from '../../core/money.js';

const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();

export function parseJson(body) {
  try { return JSON.parse(body); } catch { /* JSONP is parsed, never evaluated. */ }
  const match = body.match(/^[\w$]+\s*\(([\s\S]*)\)\s*;?\s*$/);
  if (match) try { return JSON.parse(match[1]); } catch { /* Invalid response. */ }
  return null;
}

export function extractCatalog(payload) {
  const queue = [payload], seen = new Set();
  let skuBase = null, skuCore = null, itemId = null;
  for (let visited = 0; queue.length && visited < 1000; visited++) {
    let value = queue.shift();
    if (typeof value === 'string' && value.trim().startsWith('{')) value = parseJson(value);
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    skuBase ||= value.skuBase;
    skuCore ||= value.skuCore;
    itemId ||= value.item?.itemId ? String(value.item.itemId) : null;
    for (const child of Object.values(value).slice(0, 100)) if (typeof child === 'object' || typeof child === 'string') queue.push(child);
  }
  return { skuBase, skuCore, itemId };
}

export function buildSpecs(itemId, dom, catalog = {}) {
  const props = catalog.skuBase?.props || [];
  const groups = dom.groups.map(group => {
    const prop = props.find(prop => String(prop.pid) === group.nativeId) || props.find(prop => clean(prop.name) === group.name);
    const groupId = prop ? String(prop.pid) : group.nativeId || `g:${hash(`${group.index}:${group.name}`)}`;
    return {
      groupId, name: group.name, index: group.index,
      values: group.values.map(value => {
        const native = prop?.values?.find(native => String(native.vid) === value.nativeId || clean(native.name) === value.label);
        return { valueId: native ? String(native.vid) : value.nativeId || `v:${hash(value.label)}`, label: value.label, available: !value.disabled, index: value.index };
      }),
    };
  });
  const nativeSkus = Array.isArray(catalog.skuBase?.skus) ? catalog.skuBase.skus : [];
  const variants = nativeSkus.flatMap(sku => {
    if (!sku.skuId || String(sku.skuId) === '0') return [];
    const selections = (sku.propPath || '').split(';').filter(Boolean).map(pair => {
      const [groupId, valueId] = pair.split(':');
      return { groupId, valueId };
    });
    if (selections.length !== groups.length || selections.some(value => !groups.find(group => group.groupId === value.groupId)?.values.some(option => option.valueId === value.valueId))) return [];
    return [{ specId: `sku:${sku.skuId}`, skuId: String(sku.skuId), selections, label: selections.map(value => groups.find(group => group.groupId === value.groupId).values.find(option => option.valueId === value.valueId).label).join(' / ') }];
  });
  if (!variants.length && groups.length === 1) {
    const group = groups[0];
    for (const value of group.values) variants.push({ specId: `dom:${hash(`${itemId}:${group.groupId}:${value.valueId}`)}`, skuId: null, label: value.label, selections: [{ groupId: group.groupId, valueId: value.valueId }] });
  }
  return {
    itemId, groups, variants,
    mode: groups.length ? (variants.length ? 'variants' : 'select-by-groups') : nativeSkus.length === 1 ? 'single-variant' : 'unknown',
  };
}

export function publicSpecs(specs) {
  return { ...specs, groups: specs.groups.map(({ index, ...group }) => ({ ...group, values: group.values.map(({ index, ...value }) => value) })) };
}

export function resolveSpec(specs, input) {
  if (typeof input === 'string') input = { specId: input };
  if (!input || typeof input !== 'object') throw new TaobaoError('INVALID_ARGUMENT', '必须指定 getSpecs 返回的 specId、skuId 或完整 selections。');
  if (['specId', 'skuId', 'selections', 'labels', 'kind'].filter(key => input[key] !== undefined).length !== 1) throw new TaobaoError('INVALID_ARGUMENT', '规格选择方式须且只能提供一种。');
  let variant = null, selections = input.selections;
  if (input.specId || input.skuId) {
    variant = specs.variants.find(value => value.specId === input.specId || (input.skuId && value.skuId === input.skuId));
    if (!variant) throw new TaobaoError('SKU_NOT_FOUND', '规格不属于该商品，或规格列表已变化。');
    selections = variant.selections;
  } else if (Array.isArray(input.labels)) {
    selections = input.labels.map(label => {
      const matches = specs.groups.flatMap(group => group.values.filter(value => value.label === label).map(value => ({ groupId: group.groupId, valueId: value.valueId })));
      if (matches.length !== 1) throw new TaobaoError('SPEC_AMBIGUOUS', `规格标签未唯一匹配：${label}`);
      return matches[0];
    });
  } else if (input.kind === 'default' && specs.mode === 'single-variant') {
    selections = [];
    variant = specs.variants[0] || null;
  }
  if (!Array.isArray(selections) || selections.length !== specs.groups.length || new Set(selections.map(value => value.groupId)).size !== specs.groups.length) throw new TaobaoError('INVALID_ARGUMENT', '每个规格组必须且只能选择一个值。');
  const expected = selections.map(selection => {
    const group = specs.groups.find(group => group.groupId === selection.groupId);
    const value = group?.values.find(value => value.valueId === selection.valueId);
    if (!value) throw new TaobaoError('SKU_NOT_FOUND', '规格值已变化，请重新获取规格。');
    if (!value.available) throw new TaobaoError('SKU_UNAVAILABLE', `规格不可选：${value.label}`);
    return { groupIndex: group.index, valueIndex: value.index, label: value.label };
  });
  if (!variant) variant = specs.variants.find(variant => selections.every(selection => variant.selections.some(value => value.groupId === selection.groupId && value.valueId === selection.valueId)));
  if (!variant && specs.variants.some(value => value.skuId)) throw new TaobaoError('SKU_NOT_FOUND', '该属性组合不在实际 SKU 列表中。');
  if (specs.mode === 'unknown') throw new TaobaoError('SPEC_UNAVAILABLE', '没有确认商品规格结构，不能自动使用默认价格。');
  return { specId: variant?.specId || `dom:${hash(`${specs.itemId}:${JSON.stringify(selections)}`)}`, skuId: variant?.skuId || null, selections, expected, label: expected.map(value => value.label).join(' / ') };
}

export function skuPrice(catalog, skuId) {
  if (!skuId || skuId === '0') return null;
  const record = catalog.skuCore?.sku2info?.[skuId];
  if (!record) return null;
  const value = record.price?.priceText;
  if (typeof value !== 'string') return null;
  const price = parsePrice([`${record.price?.priceTitle || ''} ${value}`.trim()]);
  return price ? { ...price, basis: record.price?.priceTitle ? price.basis : 'api-displayed', stock: record.quantity ?? null } : null;
}
