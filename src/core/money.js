// Keep currency values as decimal strings; never substitute an item's range
// or coupon price for the selected variant's ordinary displayed price.
// 小数位不设上限并加 (?!\d) 防截断：电子元器件/批发价常见 3~4 位小数（¥0.015），
// 旧的 \d{1,2} 上限会把 '¥0.015' 截成 '0.01'，造成价格失真。
export function parsePrice(texts = []) {
  const money = '(\\d[\\d,]*(?:\\.\\d+)?)(?!\\d)';
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
