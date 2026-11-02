import { writeFile } from 'node:fs/promises';
import { MtopAdapter } from '../src/adapters/taobao/mtop.js';

const adapter = new MtopAdapter({});
const catalog = await adapter.fetchCatalog('786222261977');
await writeFile(new URL('../.runtime/last-catalog.json', import.meta.url), JSON.stringify(catalog, null, 2));
console.log('top keys:', Object.keys(catalog).join(', '));
for (const [key, value] of Object.entries(catalog)) {
  console.log(key, '=>', value && typeof value === 'object' ? Object.keys(value).slice(0, 12).join(',') : typeof value);
}
