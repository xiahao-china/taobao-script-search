// Explicit real-site acceptance run. Uses the already-running service and
// records only normalized business results, never authentication material.
import { createTaobaoClient } from '../src/index.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot } from '../src/core/config.js';

const client = createTaobaoClient({ autoStart: false, onEvent: value => { if (value.message) console.error(value.message); } });
const specs = await client.getSpecs('805012477549');
if (!specs.ok) { console.log(JSON.stringify(specs)); process.exit(1); }
const labels = ['M3*10(200个)', 'M3*6(500个)', 'M3*20(100个)'];
const chosen = labels.map(label => specs.data.variants.find(value => value.label === label));
if (chosen.some(value => !value)) throw new Error('Expected labels not present in current item.');
const before = await client.status();
const result = await client.batch({
  searches: [{ keyword: 'M3盘头螺丝', options: { limit: 5 } }],
  products: [{ itemId: '805012477549', specs: chosen.map(value => ({ specId: value.specId })) }],
});
const after = await client.status();
const report = { checkedAt: new Date().toISOString(), before: before.data, result, after: after.data };
const directory = join(projectRoot, 'artifacts/runs/js-live');
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ok: result.ok, summary: result.data?.results.map(value => ({ operation: value.operation, ok: value.ok, count: value.data?.items?.length ?? value.data?.variants?.length, specLabel: value.data?.specLabel, price: value.data?.price, meta: value.meta, error: value.error })), browser: after.data.browser, detailNavigationsBefore: before.data.detailNavigations, detailNavigationsAfter: after.data.detailNavigations }, null, 2));
if (!result.ok) process.exitCode = 1;
