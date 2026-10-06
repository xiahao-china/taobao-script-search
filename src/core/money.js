// Keep currency values as decimal strings; never substitute an item's range
// or coupon price for the selected variant's ordinary displayed price.
export function parsePrice(texts = []) {
  const money = '(\\d[\\d,]*(?:\\s*\\.\\s*\\d{1,2})?)';
  for (const source of texts) {
    const text = String(source).replace(/\s+/g, ' ').trim();
    if (!text || /起(?:\s|$)|\d\s*[-~～至]\s*\d/.test(text)) continue;
    const listed = text.match(new RegExp(`(?:优惠前|原价|标价)\\s*[¥￥]?\\s*${money}`));
    const match = listed || text.match(new RegExp(`[¥￥]\\s*${money}`)) || text.match(new RegExp(`^${money}$`));
    if (!match) continue;
    const couponOnly = !listed && /券后|补贴后|到手价|预估/.test(text);
    const amount = match[1].replace(/[,\s]/g, '');
    return { amount, currency: 'CNY', basis: couponOnly ? 'conditional' : 'displayed', display: text };
  }
  return null;
}
