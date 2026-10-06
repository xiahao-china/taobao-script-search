export { TaobaoClient, startDaemon } from './service/client.js';
export { TaobaoError } from './core/errors.js';
import { TaobaoClient } from './service/client.js';
export function createTaobaoClient(options = {}) { return new TaobaoClient(options); }
