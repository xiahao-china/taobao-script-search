import { MtopAdapter, buildMtopSpecs } from './adapters/taobao/mtop.js';
import { ShopSearchAdapter } from './adapters/taobao/shop-search.js';

export { MtopAdapter, buildMtopSpecs, ShopSearchAdapter };
export { MtopClient } from './core/mtop-client.js';
export { TaobaoError } from './core/errors.js';
export function createMtopClient(options = {}) { return new MtopAdapter(options); }
