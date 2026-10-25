import { readFileSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { Policy } from './policy.js';
import { settingsSchema } from './config.js';

const directory = process.env.DATA_DIR || 'data';
const file = join(directory, 'policy.json');
let policy, stamp;
function reload() {
  const stat = statSync(file, { bigint: true });
  const next = `${stat.ino}:${stat.mtimeNs}`;
  if (next !== stamp) {
    const settings = settingsSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    if (policy) policy.update(settings); else policy = new Policy(settings);
    stamp = next;
  }
}
// Invalid or unavailable rules reject writes. Reporting failure never affects decisions.
let socket, connected = false, retryAt = 0, pending = [], pendingBytes = 0, dropped = 0;
const limit = 2 * 1024 * 1024;
function connect() {
  if (socket || Date.now() < retryAt) return;
  socket = createConnection(join(directory, 'reporting.sock'));
  socket.on('connect', () => { connected = true; flush(); });
  socket.on('error', () => {});
  socket.on('drain', flush);
  socket.on('close', () => { socket = null; connected = false; retryAt = Date.now() + 1000; });
}
function flush() {
  connect();
  if (!connected) return;
  while (pending.length && socket.writableLength < limit) {
    const line = pending.shift(); pendingBytes -= Buffer.byteLength(line);
    socket.write(line);
  }
}
function report(message, result) {
  if (!message?.event || result.msg.startsWith('invalid:')) return;
  const event = message.event;
  const review = result.action === 'accept' && policy.settings.moderation.provider !== 'off';
  const line = JSON.stringify({ event: review ? event : { id: event.id, pubkey: event.pubkey },
    action: result.action, reason: result.msg || 'Accepted', labels: result.msg.includes('banned word') ? ['word-filter'] : [],
    bytes: Buffer.byteLength(JSON.stringify(event)), review, dropped }) + '\n';
  const bytes = Buffer.byteLength(line);
  if (pending.length >= 5000 || pendingBytes + bytes > limit) { dropped++; return; }
  pending.push(line); pendingBytes += bytes;
  setImmediate(flush);
}
const timer = setInterval(flush, 1000); timer.unref();
connect();
let input = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  input = Buffer.concat([input, chunk]);
  let end;
  while ((end = input.indexOf(10)) !== -1) {
    if (end > 128 * 1024) process.exit(1);
    const line = input.subarray(0, end); input = input.subarray(end + 1);
    let message, result;
    try { message = JSON.parse(line.toString('utf8')); reload(); result = policy.decide(message); }
    catch { result = { id: message?.event?.id ?? '', action: 'reject', msg: 'error: policy rules unavailable' }; }
    process.stdout.write(JSON.stringify(result) + '\n');
    if (policy && !result.msg.startsWith('error:')) report(message, result);
  }
  if (input.length > 128 * 1024) process.exit(1);
});
process.stdin.on('end', () => { flush(); socket?.destroy(); process.exit(0); });
process.stdout.on('error', () => process.exit(1));
