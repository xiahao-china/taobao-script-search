import { createDaemon } from '../../src/service/daemon.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runtimePaths } from '../../src/core/config.js';
const paths = runtimePaths();
mkdirSync(paths.directory, { recursive: true });
for (const stream of [process.stdout, process.stderr]) {
  stream.write = (chunk, encoding, callback) => {
    appendFileSync(join(paths.directory, 'daemon.log'), chunk, typeof encoding === 'string' ? encoding : 'utf8');
    if (typeof encoding === 'function') encoding(); else if (callback) callback();
    return true;
  };
}
const argument = process.argv.find(value => value.startsWith('--config='));
try {
  const input = argument ? JSON.parse(Buffer.from(argument.slice(9), 'base64').toString('utf8')) : {};
  const daemon = await createDaemon(input);
  process.on('SIGINT', () => void daemon.close());
  process.on('SIGTERM', () => void daemon.close());
} catch (error) {
  console.error(String(error.message).split('Call log:')[0]);
  process.exitCode = 1;
}
