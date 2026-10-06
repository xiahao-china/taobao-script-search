import { createTaobaoClient } from '../src/index.js';

const [keyword, itemId, specId] = process.argv.slice(2);
if (!keyword || keyword === '--help') {
  console.log('node examples/query.js <关键词> [商品ID] [getSpecs返回的specId]');
} else {
  const client = createTaobaoClient({ onEvent: value => { if (value.message) console.error(value.message); } });
  console.log(JSON.stringify(await client.search(keyword, { limit: 5 })));
  if (itemId) console.log(JSON.stringify(await client.getSpecs(itemId)));
  if (itemId && specId) console.log(JSON.stringify(await client.getDetail(itemId, { specId })));
}
