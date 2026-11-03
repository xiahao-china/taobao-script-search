// 从导出的购物记录 CSV 中筛出实付款 > 150 元的订单，另存一份列表。
// 用法：node tools/filter-over-150.mjs [源CSV] [输出CSV] [金额阈值]
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const [src = 'artifacts/taobao-orders-since-2026-06-30.csv', out = 'artifacts/taobao-orders-over-150.csv', thresholdArg] = process.argv.slice(2);
const THRESHOLD = Number(thresholdArg) || 150;

// 解析 CSV 行（处理引号内逗号/引号）
function parseCsvLine(line) {
  const cells = [];
  let cell = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cell); cell = ''; }
    else cell += ch;
  }
  cells.push(cell);
  return cells;
}

const raw = await readFile(src, 'utf8');
const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
const header = parseCsvLine(lines[0]);
const rows = lines.slice(1).map(parseCsvLine);

// 订单行 = 下单时间非空；其后续行（下单时间为空）是同单的其余商品。
const orders = [];
for (const row of rows) {
  if (row[0]) orders.push({ rows: [row], paid: Number(row[4]) || null, time: row[0], orderId: row[1], shop: row[2], status: row[3] });
  else if (orders.length) orders[orders.length - 1].rows.push(row);
}

const large = orders.filter(order => order.paid !== null && order.paid > THRESHOLD);
const skipped = orders.filter(order => order.paid === null).length;

const outLines = [header.join(',')];
for (const order of large) for (const row of order.rows) outLines.push(row.map(csvCell).join(','));
function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
await mkdir('artifacts', { recursive: true });
await writeFile(out, '\uFEFF' + outLines.join('\r\n') + '\r\n');

// 统计
const paidList = large.map(order => order.paid).sort((a, b) => b - a);
const total = paidList.reduce((sum, value) => sum + value, 0);
const byMonth = new Map();
for (const order of large) {
  const month = order.time.slice(0, 7);
  byMonth.set(month, (byMonth.get(month) || { count: 0, sum: 0 }));
  byMonth.get(month).count += 1;
  byMonth.get(month).sum += order.paid;
}
const byShop = new Map();
for (const order of large) byShop.set(order.shop, (byShop.get(order.shop) || 0) + order.paid);
const topShops = [...byShop.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

console.log(`订单总数 ${orders.length}（其中 ${skipped} 单无实付金额未参与过滤）`);
console.log(`实付款 > ${THRESHOLD} 元：${large.length} 单，合计 ${total.toFixed(2)} 元，均值 ${(total / large.length).toFixed(2)}，中位数 ${paidList[Math.floor(paidList.length / 2)]}`);
console.log(`最高一笔：${large[0] ? paidList[0] + ' 元 ' + large.find(o => o.paid === paidList[0])?.shop + ' ' + large.find(o => o.paid === paidList[0])?.time : '-'}`);
console.log('--- 按月 ---');
for (const [month, stat] of [...byMonth.entries()].sort()) console.log(`${month}: ${stat.count} 单 / ${stat.sum.toFixed(2)} 元`);
console.log('--- 按店铺 TOP8 ---');
for (const [shop, sum] of topShops) console.log(`${shop}: ${sum.toFixed(2)} 元（${large.filter(o => o.shop === shop).length} 单）`);
console.log(`明细已写入 ${out}`);
