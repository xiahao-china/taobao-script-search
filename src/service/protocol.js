import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { TaobaoError } from '../core/errors.js';

export const protocolVersion = 1;
export const maxMessageBytes = 2 * 1024 * 1024;

export function consumeLines(socket, callback, onError) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > maxMessageBytes) { onError(new TaobaoError('INVALID_ARGUMENT', 'IPC 消息超过 2 MiB。')); socket.destroy(); return; }
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try { callback(JSON.parse(line)); } catch (error) { onError(error); }
    }
  });
}

export function send(socket, value) { if (!socket.destroyed && socket.writable) socket.write(JSON.stringify(value) + '\n'); }

export function rpc(paths, token, operation, params = {}, { onEvent = () => {}, signal, onAccepted = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(paths.endpoint);
    let final = false;
    const finish = (error, value) => {
      if (final) return;
      final = true;
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(new TaobaoError('CANCELLED', '已取消等待任务结果。'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('connect', () => send(socket, { version: protocolVersion, requestId: randomUUID(), token, operation, params }));
    socket.once('error', error => finish(error));
    socket.once('close', () => { if (!final) finish(new TaobaoError('SERVICE_DISCONNECTED', '常驻服务连接已断开。')); });
    consumeLines(socket, message => {
      if (message.kind === 'accepted') onAccepted(message.jobId);
      else if (message.kind === 'event') onEvent(message.event);
      else if (message.kind === 'result') finish(null, message.result);
      else if (message.kind === 'error') finish(new TaobaoError(message.error.code, message.error.message));
    }, error => finish(error));
  });
}
