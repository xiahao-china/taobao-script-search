// 响应体解析：JSON 优先，JSONP 只解析不执行。mtop-client 与 specs 共用。
export function parseBody(body) {
  try { return JSON.parse(body); } catch { /* 退化尝试 JSONP。 */ }
  const match = body.match(/^[\w$]+\s*\(([\s\S]*)\)\s*;?\s*$/);
  if (match) try { return JSON.parse(match[1]); } catch { /* 非法响应交给上层报错。 */ }
  return null;
}
