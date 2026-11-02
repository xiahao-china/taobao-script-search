export { MtopAdapter, buildMtopSpecs } from './adapters/taobao/mtop.js';
export { MtopClient } from './core/mtop-client.js';
export { TaobaoError } from './core/errors.js';
export function createMtopClient(options = {}) { return new MtopAdapter(options); }
