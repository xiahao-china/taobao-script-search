export function readSearch(args) {
  const helper = window.__taobaoScriptSearch;
  const manual = helper.auth();
  if (manual) return { status: manual, items: [] };
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = node => Boolean(node?.getClientRects().length) && getComputedStyle(node).visibility !== 'hidden';
  const text = node => visible(node) ? clean(node.innerText) : '';
  const url = new URL(location.href);
  if (args.keyword && (url.hostname !== 's.taobao.com' || url.searchParams.get('q') !== args.keyword || (url.searchParams.get('page') || '1') !== String(args.page))) return { status: 'wrong_page', items: [] };
  const container = document.querySelector('#content_items_wrapper');
  const items = [], seen = new Set();
  for (const anchor of (container || document).querySelectorAll('a[href]')) {
    if (!visible(anchor)) continue;
    let href;
    try { href = new URL(anchor.href, location.href); } catch { continue; }
    if (!['item.taobao.com', 'detail.tmall.com', 'detail.tmall.hk'].includes(href.hostname) || href.pathname !== '/item.htm') continue;
    const id = href.searchParams.get('id');
    if (!/^\d+$/.test(id || '') || seen.has(id)) continue;
    let root = anchor;
    if (container) while (root.parentElement && root.parentElement !== container) root = root.parentElement;
    else root = anchor.closest('[data-item-id], [class*="doubleCard"], [class*="DoubleCard"], [class*="cardWrapper"]') || anchor;
    const image = root.querySelector('img');
    const title = text(root.querySelector('[class*="descWrapper"] span, [class*="title"], [class*="Title"], [class*="desc"]')) || clean(anchor.title) || clean(image?.alt);
    if (!title) continue;
    const priceNode = root.querySelector('[class*="innerPriceWrapper"]') || root.querySelector('[class*="priceWrapper"], [class*="PriceWrapper"], [class*="price"], [class*="Price"]');
    const priceText = text(priceNode) || text(root).match(/[¥￥]\s*\d[\d,. ]*/)?.[0] || null;
    items.push({ itemId: id, title, priceText, shopName: text(root.querySelector('[class*="shopNameText"], [class*="shopName"], [class*="ShopName"]')) || null, salesText: text(root).match(/[\d.]+\s*(?:万|亿)?\+?\s*(?:人付款|人已付款|人购买|人收货|人已买)/)?.[0] || null, url: `${href.origin}${href.pathname}?id=${id}`, imageUrl: image?.currentSrc || image?.src || null });
    seen.add(id);
    if (items.length >= args.limit) break;
  }
  if (!items.length && /没有找到相关|暂无搜索结果|没有相关商品|没有找到宝贝/.test(document.body?.innerText || '')) return { status: 'no_results', items: [] };
  if (!items.length) return { status: 'loading', items: [] };
  const fingerprint = JSON.stringify(items);
  if (helper.searchReady?.nonce !== args.nonce || helper.searchReady.fingerprint !== fingerprint) helper.searchReady = { nonce: args.nonce, fingerprint, changedAt: performance.now() };
  const ready = items.length >= args.limit || performance.now() - helper.searchReady.changedAt >= (args.quietMs || 200);
  return { status: ready ? 'ok' : 'loading', items };
}
