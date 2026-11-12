// GBK 编码器（零依赖）：店内搜索 asynSearch 的 q 参数按 GBK 百分号编码提交
// （与浏览器行为一致，见 HAR：q=0805+%B5%E7%D7%E8）。Node 只有 TextDecoder
// 能解 GBK、没有对应编码器——利用解码表的反查构造编码：枚举全部双字节
// 组合（0x81-0xFE × 0x40-0xFE）逐个解码建 char→bytes 映射，进程内只建一次。
// 双字节组合若多对一同字（GBK 收录重叠区），任取其一：服务端解码后得到
// 同一个字符即可，检索语义不受影响。
let reverseTable = null;

function buildReverseTable() {
  const decoder = new TextDecoder('gbk');
  const table = new Map();
  const pair = new Uint8Array(2);
  for (let lead = 0x81; lead <= 0xFE; lead++) {
    pair[0] = lead;
    for (let trail = 0x40; trail <= 0xFE; trail++) {
      if (trail === 0x7F) continue;
      pair[1] = trail;
      const ch = decoder.decode(pair);
      if (ch === '\uFFFD' || table.has(ch)) continue;
      table.set(ch, `${lead.toString(16).padStart(2, '0').toUpperCase()}`
        + `${trail.toString(16).padStart(2, '0').toUpperCase()}`);
    }
  }
  return table;
}

// 字符串 → GBK 百分号编码（application/x-www-form-urlencoded 风格：
// 空格编码为 +，ASCII 安全字符原样，其余按字节 %XX）。
// 非 ASCII 且不在 GBK 收录范围的字符直接报错——静默替换会导致搜错词。
export function gbkEncode(text) {
  if (!reverseTable) reverseTable = buildReverseTable();
  let out = '';
  for (const ch of String(text)) {
    if (ch === ' ') { out += '+'; continue; }
    const code = ch.codePointAt(0);
    if (code < 0x80) {
      // ASCII：字母数字和 -_.~ 原样，其余 %XX（含 &?= 等保留字，避免破坏参数结构）。
      out += /[A-Za-z0-9_.~-]/.test(ch) ? ch : `%${code.toString(16).padStart(2, '0').toUpperCase()}`;
      continue;
    }
    const hex = reverseTable.get(ch);
    if (!hex) throw new Error(`字符「${ch}」不在 GBK 编码范围，店内搜索无法提交该关键词。`);
    out += `%${hex.slice(0, 2)}%${hex.slice(2, 4)}`;
  }
  return out;
}
