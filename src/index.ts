import { MtopAdapter, buildMtopSpecs } from './adapters/taobao/mtop.js';
import type { MtopAdapterOptions } from './adapters/taobao/mtop.js';
import { ShopSearchAdapter } from './adapters/taobao/shop-search.js';
import type { ShopSearchAdapterOptions } from './adapters/taobao/shop-search.js';

export { MtopAdapter, buildMtopSpecs, ShopSearchAdapter };
export type { MtopAdapterOptions, ShopSearchAdapterOptions };
export { MtopClient } from './core/mtop-client.js';
export { TaobaoError } from './core/errors.js';
export type * from './types.js';

export function createMtopClient(options: MtopAdapterOptions = {}): MtopAdapter {
  return new MtopAdapter(options);
}
