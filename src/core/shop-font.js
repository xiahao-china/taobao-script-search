// WOFF1 价格字体解码（零依赖）：淘宝店内搜索的价格用 CJK 码点实体渲染，
// 页面配发的 AlibabaSans102CustomFont 字体把 CJK 码点映射到名为
// one/two/period… 的 glyph。解法：cmap 取 码点→glyphIndex，post v2 取
// glyphIndex→glyph 名，名字即明文。映射每次会话轮换，但同会话
// 页面字体 × asynSearch 数据天然配对（2026-11-12 实测成立）。
import { inflateSync } from 'node:zlib';

// Macintosh 标准序 258 个 glyph 名（post glyphNameIndex < 258 时按序号取名）。
const MAC_GLYPH_NAMES = [
  '.notdef', '.null', 'nonmarkingreturn', 'space', 'exclam', 'quotedbl', 'numbersign',
  'dollar', 'percent', 'ampersand', 'quotesingle', 'parenleft', 'parenright', 'asterisk',
  'plus', 'comma', 'hyphen', 'period', 'slash', 'zero', 'one', 'two', 'three', 'four',
  'five', 'six', 'seven', 'eight', 'nine', 'colon', 'semicolon', 'less', 'equal',
  'greater', 'question', 'at', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K',
  'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'bracketleft',
  'backslash', 'bracketright', 'asciicircum', 'underscore', 'grave', 'a', 'b', 'c', 'd',
  'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u',
  'v', 'w', 'x', 'y', 'z', 'braceleft', 'bar', 'braceright', 'asciitilde',
  'Adieresis', 'Aring', 'Ccedilla', 'Eacute', 'Ntilde', 'Odieresis', 'Udieresis',
  'aacute', 'agrave', 'acircumflex', 'adieresis', 'atilde', 'aring', 'ccedilla',
  'eacute', 'egrave', 'ecircumflex', 'edieresis', 'igrave', 'icircumflex', 'idieresis',
  'ntilde', 'oacute', 'ograve', 'ocircumflex', 'odieresis', 'otilde', 'uacute',
  'ugrave', 'ucircumflex', 'udieresis', 'dagger', 'degree', 'cent', 'sterling',
  'section', 'bullet', 'paragraph', 'germandbls', 'registered', 'copyright',
  'trademark', 'acute', 'dieresis', 'notequal', 'AE', 'Oslash', 'infinity', 'plusminus',
  'lessequal', 'greaterequal', 'yen', 'mu', 'partialdiff', 'summation', 'product',
  'pi', 'integral', 'ordfeminine', 'ordmasculine', 'Omega', 'ae', 'oslash',
  'questiondown', 'exclamdown', 'logicalnot', 'radical', 'florin', 'approxequal',
  'Delta', 'guillemotleft', 'guillemotright', 'ellipsis', 'nonbreakingspace', 'Agrave',
  'Atilde', 'Otilde', 'OE', 'oe', 'endash', 'emdash', 'quotedblleft', 'quotedblright',
  'quoteleft', 'quoteright', 'divide', 'lozenge', 'ydieresis', 'Ydieresis',
  'fraction', 'currency', 'guilsinglleft', 'guilsinglright', 'fi', 'fl', 'daggerdbl',
  'periodcentered', 'quotesinglbase', 'quotedblbase', 'perthousand', 'Acircumflex',
  'Ecircumflex', 'Icircumflex', 'Ocircumflex', 'Ucircumflex', 'dotlessi', 'circumflex',
  'tilde', 'macron', 'breve', 'dotaccent', 'ring', 'cedilla', 'hungarumlaut',
  'ogonek', 'caron', 'Lslash', 'lslash', 'Scaron', 'scaron', 'Zcaron', 'zcaron',
  'brokenbar', 'Eth', 'eth', 'Yacute', 'yacute', 'Thorn', 'thorn', 'minus',
  'multiply', 'onesuperior', 'twosuperior', 'threesuperior', 'onehalf', 'onequarter',
  'threequarters', 'franc', 'Gbreve', 'gbreve', 'Idotaccent', 'Scedilla', 'scedilla',
  'Cacute', 'cacute', 'Ccaron', 'ccaron', 'dcroat',
];

// glyph 名 → 显示字符（缺省 null = 该码点丢弃）。
const NAME2CHAR = {
  zero: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  period: '.', comma: ',',
};

const u16 = (buf, off) => buf.readUInt16BE(off);
const u32 = (buf, off) => buf.readUInt32BE(off);

// WOFF1 表目录：tag/offset/compLength/origLength/origChecksum 各 4 字节。
function woffTable(buffer, tag) {
  if (buffer.readUInt32BE(0) !== 0x774F4646) throw new Error('非 WOFF1 字体（签名不符）');
  const numTables = u16(buffer, 12);
  for (let i = 0; i < numTables; i++) {
    const base = 44 + i * 20;
    const tagStr = buffer.toString('latin1', base, base + 4);
    if (tagStr !== tag) continue;
    const offset = u32(buffer, base + 4);
    const compLength = u32(buffer, base + 8);
    const origLength = u32(buffer, base + 12);
    const raw = buffer.subarray(offset, offset + compLength);
    return compLength < origLength ? inflateSync(raw) : Buffer.from(raw);
  }
  throw new Error(`WOFF1 缺少 ${tag} 表`);
}

// cmap：优先 format12（group 三元组），退回 format4（segment 二分）。
function parseCmap(cmap) {
  const numTables = u16(cmap, 2);
  let sub = null;
  for (let i = 0; i < numTables; i++) {
    const base = 4 + i * 8;
    const platform = u16(cmap, base);
    const encoding = u16(cmap, base + 2);
    const offset = u32(cmap, base + 4);
    const format = u16(cmap, offset);
    if (format === 12) return parseCmap12(cmap, offset);
    if (format === 4 && (platform === 3 || sub === null)) sub = [platform, encoding, offset];
  }
  if (sub) return parseCmap4(cmap, sub[2]);
  throw new Error('cmap 无可解析子表（仅支持 format 4/12）');
}

function parseCmap12(cmap, offset) {
  const nGroups = u32(cmap, offset + 12);
  const map = new Map();
  for (let i = 0; i < nGroups; i++) {
    const base = offset + 16 + i * 12;
    const start = u32(cmap, base);
    const end = u32(cmap, base + 4);
    const startGlyph = u32(cmap, base + 8);
    for (let cp = start; cp <= end && cp - start < 65536; cp++) map.set(cp, startGlyph + (cp - start));
  }
  return map;
}

function parseCmap4(cmap, offset) {
  const segCountX2 = u16(cmap, offset + 6);
  const segCount = segCountX2 / 2;
  const endCodes = offset + 14;
  const startCodes = endCodes + segCountX2 + 2;
  const idDeltas = startCodes + segCountX2;
  const idRangeOffsets = idDeltas + segCountX2;
  const map = new Map();
  for (let seg = 0; seg < segCount; seg++) {
    const end = u16(cmap, endCodes + seg * 2);
    const start = u16(cmap, startCodes + seg * 2);
    const delta = u16(cmap, idDeltas + seg * 2) | 0;
    const rangeOffset = u16(cmap, idRangeOffsets + seg * 2);
    if (start === 0xFFFF) continue;
    for (let cp = start; cp <= end; cp++) {
      let glyph;
      if (rangeOffset === 0) glyph = (cp + delta) & 0xFFFF;
      else {
        const addr = idRangeOffsets + seg * 2 + rangeOffset + (cp - start) * 2;
        glyph = u16(cmap, addr);
        if (glyph !== 0) glyph = (glyph + delta) & 0xFFFF;
      }
      if (glyph) map.set(cp, glyph);
    }
  }
  return map;
}

// post v2.0：32 字节头 + numGlyphs + glyphNameIndex[] + 自定义名 pascal 串。
function parsePostNames(post, numGlyphsFromMaxp) {
  const version = u32(post, 0);
  if (version !== 0x00020000) throw new Error(`post 表版本 ${version.toString(16)} 非 2.0，glyph 名不可用`);
  const numGlyphs = u16(post, 32);
  const names = new Array(numGlyphs);
  const indexBase = 34;
  // 自定义名串区起点：glyphNameIndex 之后。
  let strBase = indexBase + numGlyphs * 2;
  const custom = [];
  while (strBase < post.length) {
    const len = post[strBase++];
    custom.push(post.toString('latin1', strBase, strBase + len));
    strBase += len;
  }
  for (let i = 0; i < numGlyphs; i++) {
    const idx = u16(post, indexBase + i * 2);
    names[i] = idx < 258 ? MAC_GLYPH_NAMES[idx] : custom[idx - 258] ?? null;
  }
  // numGlyphs 与 maxp 不一致时以 post 为准（names 数组即按 post 生成）。
  void numGlyphsFromMaxp;
  return names;
}

// 主入口：WOFF1 buffer → Map<码点, 显示字符>（只收数字/小数点/逗号）。
export function parsePriceFontMap(buffer) {
  const cmap = parseCmap(woffTable(buffer, 'cmap'));
  const post = woffTable(buffer, 'post');
  const names = parsePostNames(post);
  const map = new Map();
  for (const [cp, glyphIndex] of cmap) {
    const ch = NAME2CHAR[names[glyphIndex]];
    if (ch) map.set(cp, ch);
  }
  return map;
}

// HTML 里的 &#NNNNN; 实体串 → 明文（不在映射里的码点记 '?'，保持位数可对账）。
export function decodeEntities(entities, fontMap) {
  let out = '';
  for (const m of entities.matchAll(/&#(\d+);/g)) {
    out += fontMap.get(Number(m[1])) ?? '?';
  }
  return out;
}
