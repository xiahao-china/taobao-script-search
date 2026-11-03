// 图片/链接字段统一补协议：淘宝接口常返回 '//host/path' 协议相对地址，
// 也偶见已带协议的完整 URL；拼接前归一化，避免产出 'https:https://...' 这类非法地址。
export function normalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  return text.startsWith('//') ? `https:${text}` : text;
}
