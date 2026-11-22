import { createHash } from 'node:crypto';
import { TaobaoError } from '../../core/errors.js';
import { parsePrice } from '../../core/money.js';
import { parseBody } from '../../core/json-body.js';
import type {
  ExtractedCatalog,
  InternalSpecs,
  PublicSpecs,
  RawSkuBase,
  RawSkuCore,
  ResolvedSpec,
  SkuPriceResult,
  SpecInput,
  SpecSelection,
  SpecVariant,
} from '../../types.js';

const hash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);
const clean = (value: unknown): string => String(value || '').replace(/\s+/g, ' ').trim();

// 单趟 BFS 展开节点（解开内嵌 JSON 字符串）；用下标推进避免 queue.shift() 的 O(n) 移位开销。
export function expandNodes(
  data: unknown,
  { maxNodes = 1000, maxChildren = 100 }: { maxNodes?: number; maxChildren?: number } = {},
): Record<string, unknown>[] {
  const queue: unknown[] = [data];
  const seen = new Set<unknown>();
  const nodes: Record<string, unknown>[] = [];
  for (let head = 0; head < queue.length && nodes.length < maxNodes; head++) {
    let value: unknown = queue[head];
    if (typeof value === 'string' && value.trim().startsWith('{')) value = parseBody(value);
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    nodes.push(value as Record<string, unknown>);
    const children = Object.values(value as Record<string, unknown>);
    const limit = Math.min(children.length, maxChildren);
    for (let i = 0; i < limit; i++) {
      const child = children[i];
      if (typeof child === 'object' || typeof child === 'string') queue.push(child);
    }
  }
  return nodes;
}

export function extractCatalogFromNodes(nodes: readonly Record<string, unknown>[]): ExtractedCatalog {
  let skuBase: RawSkuBase | null = null;
  let skuCore: RawSkuCore | null = null;
  let itemId: string | null = null;
  for (const value of nodes) {
    if (!skuBase && value.skuBase && typeof value.skuBase === 'object') {
      skuBase = value.skuBase as RawSkuBase;
    }
    if (!skuCore && value.skuCore && typeof value.skuCore === 'object') {
      skuCore = value.skuCore as RawSkuCore;
    }
    if (!itemId && value.item && typeof value.item === 'object') {
      const rawId = (value.item as { itemId?: unknown }).itemId;
      if (rawId != null) itemId = String(rawId);
    }
    if (skuBase && skuCore && itemId) break;
  }
  return { skuBase, skuCore, itemId };
}

export function extractCatalog(payload: unknown): ExtractedCatalog {
  return extractCatalogFromNodes(expandNodes(payload));
}

export function publicSpecs(specs: InternalSpecs): PublicSpecs {
  return {
    ...specs,
    groups: specs.groups.map(({ index: _gIdx, ...group }) => ({
      ...group,
      values: group.values.map(({ index: _vIdx, ...value }) => value),
    })),
  };
}

export function resolveSpec(specs: InternalSpecs, input: SpecInput | Record<string, unknown>): ResolvedSpec {
  const normalized: Record<string, unknown> = typeof input === 'string' ? { specId: input } : input;
  if (!normalized || typeof normalized !== 'object') {
    throw new TaobaoError('INVALID_ARGUMENT', '必须指定 getSpecs 返回的 specId、skuId 或完整 selections。');
  }
  if (['specId', 'skuId', 'selections', 'labels', 'kind'].filter(key => normalized[key] !== undefined).length !== 1) {
    throw new TaobaoError('INVALID_ARGUMENT', '规格选择方式须且只能提供一种。');
  }
  let variant: SpecVariant | null = null;
  let selections: SpecSelection[] | undefined = Array.isArray(normalized.selections)
    ? (normalized.selections as SpecSelection[])
    : undefined;

  if (normalized.specId || normalized.skuId) {
    variant = specs.variants.find(
      value => value.specId === normalized.specId || (Boolean(normalized.skuId) && value.skuId === normalized.skuId),
    ) ?? null;
    if (!variant) throw new TaobaoError('SKU_NOT_FOUND', '规格不属于该商品，或规格列表已变化。');
    selections = variant.selections;
  } else if (Array.isArray(normalized.labels)) {
    // 三级匹配：① 单标签精确命中某 variant 组合标签（用户常把 variant.label
    // 整串传回）；② 标签数与组数一致时按位置对组消歧（跨组同名值不再误报
    // SPEC_AMBIGUOUS）；③ 兜底全局唯一匹配。所有标签先做空白归一化，与
    // buildMtopSpecs 的 clean 口径一致。
    const wanted = normalized.labels.map(label => clean(label));
    let resolved: SpecSelection[] | null = null;
    if (wanted.length === 1) {
      const direct = specs.variants.find(entry => entry.label === wanted[0]);
      if (direct) { variant = direct; resolved = direct.selections; }
    }
    if (!resolved && wanted.length === specs.groups.length && specs.groups.length) {
      const positional = wanted.map((label, index) => {
        const group = specs.groups[index];
        const value = group?.values.find(entry => entry.label === label);
        return group && value ? { groupId: group.groupId, valueId: value.valueId } : null;
      });
      // 位置全命中才采用；任何一位落空说明标签顺序与组序不同，交给兜底逻辑。
      if (positional.every((item): item is SpecSelection => item !== null)) resolved = positional;
    }
    if (!resolved) {
      resolved = wanted.map(label => {
        const matches = specs.groups.flatMap(group =>
          group.values.filter(value => value.label === label).map(value => ({ groupId: group.groupId, valueId: value.valueId })),
        );
        if (matches.length !== 1 || !matches[0]) throw new TaobaoError('SPEC_AMBIGUOUS', `规格标签未唯一匹配：${label}`);
        return matches[0];
      });
    }
    selections = resolved;
  } else if (normalized.kind === 'default' && specs.mode === 'single-variant') {
    selections = [];
    variant = specs.variants[0] ?? null;
  }

  if (!Array.isArray(selections) || selections.length !== specs.groups.length || new Set(selections.map(value => value.groupId)).size !== specs.groups.length) {
    throw new TaobaoError('INVALID_ARGUMENT', '每个规格组必须且只能选择一个值。');
  }
  const expected = selections.map(selection => {
    const group = specs.groups.find(g => g.groupId === selection.groupId);
    const value = group?.values.find(v => v.valueId === selection.valueId);
    if (!group || !value) throw new TaobaoError('SKU_NOT_FOUND', '规格值已变化，请重新获取规格。');
    if (!value.available) throw new TaobaoError('SKU_UNAVAILABLE', `规格不可选：${value.label}`);
    return { groupIndex: group.index, valueIndex: value.index, label: value.label };
  });
  if (!variant) {
    variant = specs.variants.find(v =>
      selections.every(selection => v.selections.some(entry => entry.groupId === selection.groupId && entry.valueId === selection.valueId)),
    ) ?? null;
  }
  if (!variant && specs.variants.some(value => value.skuId)) {
    throw new TaobaoError('SKU_NOT_FOUND', '该属性组合不在实际 SKU 列表中。');
  }
  if (specs.mode === 'unknown') {
    throw new TaobaoError('SPEC_UNAVAILABLE', '没有确认商品规格结构，不能自动使用默认价格。');
  }
  return {
    specId: variant?.specId || `dom:${hash(`${specs.itemId}:${JSON.stringify(selections)}`)}`,
    skuId: variant?.skuId || null,
    selections,
    expected,
    label: expected.map(value => value.label).join(' / '),
  };
}

export function skuPrice(catalog: Pick<ExtractedCatalog, 'skuCore'>, skuId: string | null | undefined): SkuPriceResult | null {
  if (!skuId || skuId === '0') return null;
  const record = catalog.skuCore?.sku2info?.[skuId];
  if (!record) return null;
  const value = record.price?.priceText;
  if (typeof value !== 'string') return null;
  const price = parsePrice([`${record.price?.priceTitle || ''} ${value}`.trim()]);
  return price ? { ...price, basis: record.price?.priceTitle ? price.basis : 'api-displayed', stock: record.quantity ?? null } : null;
}
