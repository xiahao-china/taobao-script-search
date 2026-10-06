export function readDetail(args = {}) {
  const helper = window.__taobaoScriptSearch;
  const manual = helper.auth();
  if (manual) return { status: manual };
  const visible = node => Boolean(node?.getClientRects().length) && getComputedStyle(node).visibility !== 'hidden';
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const text = node => visible(node) ? clean(node.innerText) : '';
  const url = new URL(location.href);
  if (!['item.taobao.com', 'detail.tmall.com', 'detail.tmall.hk'].includes(url.hostname) || url.searchParams.get('id') !== args.itemId) return { status: 'wrong_page' };
  if (/宝贝不存在|商品不存在|商品已失效/.test((document.body?.innerText || '').slice(0, 1500))) return { status: 'item_unavailable' };
  const candidates = [...document.querySelectorAll('[data-sku-group], [class*="skuItem"]')].filter(visible);
  const roots = candidates.filter(node => !candidates.some(other => other !== node && other.contains(node)));
  const groups = [];
  for (const root of roots) {
    const options = [...root.querySelectorAll('[data-sku-value], [class*="valueItem--"], [role="radio"]')].filter(visible);
    const leaves = options.filter(node => !options.some(other => other !== node && other.contains(node)));
    const groupIndex = groups.length;
    root.setAttribute('data-tss-group', String(groupIndex));
    const values = [], labels = new Set();
    for (const node of leaves) {
      const label = text(node) || clean(node.title) || clean(node.querySelector('img')?.alt);
      if (!label || labels.has(label)) continue;
      labels.add(label);
      const index = values.length;
      node.setAttribute('data-tss-value', String(index));
      values.push({ index, label, nativeId: node.getAttribute('data-value-id') || node.getAttribute('data-vid'), selected: node.getAttribute('aria-checked') === 'true' || /isSelected|\bselected(?:--|\b)|\bSelected/.test(String(node.className)), disabled: node.getAttribute('aria-disabled') === 'true' || node.hasAttribute('disabled') || /disabled|Disabled/.test(String(node.className)) });
    }
    if (values.length) groups.push({ index: groupIndex, nativeId: root.getAttribute('data-pid') || root.getAttribute('data-property-id'), name: text(root.querySelector('[data-group-name], [class*="skuTitle"], [class*="skuLabel"]')) || clean(root.innerText.split('\n')[0]) || `规格 ${groupIndex + 1}`, values });
  }
  const panel = document.querySelector('[class*="PurchasePanel"], [class*="purchasePanel"], [data-purchase-panel]') || document;
  let priceNodes = [...panel.querySelectorAll('[class*="normalPrice"], [data-current-price]')].filter(visible);
  if (!priceNodes.length) priceNodes = [...panel.querySelectorAll('[class*="price"], [class*="Price"]')].filter(node => visible(node) && text(node).length < 250 && /[¥￥]|^\d[\d,. ]*$/.test(text(node)));
  const priceTexts = [...new Set(priceNodes.map(text).filter(Boolean))];
  const priceFingerprint = JSON.stringify(priceTexts);
  if (helper.priceReady?.fingerprint !== priceFingerprint) helper.priceReady = { fingerprint: priceFingerprint, changedAt: performance.now() };
  const selection = groups.flatMap(group => group.values.filter(value => value.selected).map(value => ({ groupIndex: group.index, valueIndex: value.index, label: value.label })));
  const selectionMatches = !args.expected || args.expected.every(value => selection.some(selected => selected.groupIndex === value.groupIndex && selected.valueIndex === value.valueIndex));
  const busy = priceNodes.some(node => node.getAttribute('aria-busy') === 'true' || [...node.querySelectorAll('[aria-busy="true"], [class*="loading"], [class*="Loading"]')].some(visible));
  const priceBound = args.skuId && priceNodes.some(node => node.getAttribute('data-sku-id') === args.skuId);
  const priceUpdated = !args.selectionChanged || priceFingerprint !== args.beforePriceFingerprint || priceBound || args.hasBoundPrice;
  const numericPrice = priceTexts.some(value => /\d/.test(value) && !/起(?:\s|$)|\d\s*[-~～至]\s*\d/.test(value));
  const settled = performance.now() - (helper.priceReady?.changedAt || 0) >= (args.quietMs ?? 120);
  const ready = groups.length > 0 || Boolean(args.singleVariant);
  const description = document.querySelector('[data-product-description], #description, [class*="detailDesc"], [class*="DetailDesc"]');
  return {
    status: ready ? 'ok' : 'loading', itemId: args.itemId,
    title: text(document.querySelector('[class*="mainTitle"], [data-product-title]')) || clean(document.title.replace(/[-_ ]*淘宝网$/, '')),
    groups, selected: selection, priceTexts, priceFingerprint,
    priceReady: Boolean(selectionMatches && !busy && priceUpdated && settled && (numericPrice || args.hasBoundPrice)),
    shopName: text(document.querySelector('[class*="shopName"], [data-shop-name]')) || null,
    shipping: /免运费|包邮/.test(text(panel)) ? { display: '页面显示免运费', amount: '0', currency: 'CNY' } : null,
    attributes: [...document.querySelectorAll('[data-product-attribute], [class*="attributeItem"], [class*="AttributeItem"]')].filter(visible).map(text).filter(Boolean),
    description: description ? { text: text(description) || null, imageUrls: [...description.querySelectorAll('img')].map(node => node.currentSrc || node.src).filter(Boolean) } : null,
    imageUrls: [...document.querySelectorAll('[class*="PicGallery"] img, [class*="picGallery"] img, [data-product-image]')].map(node => node.currentSrc || node.src).filter(Boolean),
  };
}

export function readEmbedded() {
  const roots = [window.__INIT_DATA, window.__INITIAL_STATE__, window.__ICE_APP_CONTEXT__, window.__GLOBAL_DATA__].filter(Boolean);
  const queue = roots.map(value => ({ value, depth: 0 })), seen = new Set();
  let skuBase = null, skuCore = null, itemId = null;
  for (let visited = 0; queue.length && visited < 1000; visited++) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (value.skuBase) skuBase ||= value.skuBase;
    if (value.skuCore) skuCore ||= value.skuCore;
    if (value.item?.itemId) itemId ||= String(value.item.itemId);
    if (depth < 6) for (const child of Object.values(value).slice(0, 100)) if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
  }
  return JSON.parse(JSON.stringify({ skuBase, skuCore, itemId }));
}
