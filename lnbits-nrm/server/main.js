import { existsSync } from 'node:fs';
import { mkdir, chmod, rm } from 'node:fs/promises';
import { Reporting, RelayMetrics } from './reporting.js';
import { resolve, join } from 'node:path';
import { Store } from './store.js';
import { pubkey, runtimeOptions } from './config.js';
import { Moderator } from './moderation.js';
import { ReviewWorker } from './review-worker.js';
import { Relay } from './relay.js';
import { requireExistingDatabase } from './storage.js';
import { createApp } from './api.js';

process.umask(0o077);
const capabilities = runtimeOptions();
const dataDir = resolve(process.env.DATA_DIR || 'data');
if (capabilities.requireExistingDb) await requireExistingDatabase(join(dataDir, 'strfry-db'));
await mkdir(dataDir, { recursive: true, mode: 0o700 });
// Existing installations keep their database and WAL files in place.
const settingsFile = existsSync(join(dataDir, 'aedos.sqlite')) ? 'aedos.sqlite' : 'lnbits-nrm.sqlite';
const store = new Store(join(dataDir, settingsFile), capabilities);
const admins = (process.env.ADMIN_NPUBS || '').split(/[\s,]+/).filter(Boolean).map(pubkey);
const origin = new URL(process.env.PUBLIC_ORIGIN || 'http://localhost:3000').origin;
if (!['http:', 'https:'].includes(new URL(origin).protocol)) throw new Error('PUBLIC_ORIGIN must use HTTP(S)');
const relayUrl = process.env.RELAY_URL || 'ws://localhost:7777';
if (!['ws:', 'wss:'].includes(new URL(relayUrl).protocol)) throw new Error('RELAY_URL must use WS(S)');
let shuttingDown = false;
const relay = new Relay(store, {
  dataDir, bin: process.env.STRFRY_BIN, relayUrl,
  name: process.env.RELAY_NAME || 'LNbits NRM', description: process.env.RELAY_DESCRIPTION || 'LNbits Nostr Relay Manager',
  pubkey: process.env.RELAY_PUBKEY ? pubkey(process.env.RELAY_PUBKEY) : admins[0],
  contact: process.env.RELAY_CONTACT || '', onFatal: () => { void shutdown(1); }
});
const socket = join(dataDir, 'reporting.sock');
await rm(socket, { force: true });
const reporting = new Reporting(store);
await new Promise((done, reject) => { reporting.server.once('error', reject); reporting.server.listen(socket, done); });
await chmod(socket, 0o600);
relay.reporting = reporting;
reporting.start();
const metrics = new RelayMetrics(store);
relay.metrics = metrics;
await relay.configure();
const app = await createApp({ store, relay, admins, origin });
await app.listen({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 3000) });
relay.start();
metrics.start();
const policySync = setInterval(() => { if (!shuttingDown) void relay.applyPolicy().catch(() => {}); }, 1000);
const reviews = store.aiModerationEnabled ? new ReviewWorker(store, new Moderator(store), relay) : null;
relay.reviewWorker = reviews;
reviews?.start();
if (!store.aiModerationEnabled) console.log('AI moderation is disabled by the server operator');
console.log(`LNbits NRM UI: ${origin}; relay: ${relayUrl}`);
if (!admins.length) console.log('Management is locked. Set ADMIN_NPUBS to your operator public key and restart.');
function scheduledSweep() {
  if (shuttingDown) return;
  try {
    store.cleanup();
    if (!relay.busy) relay.maintenance('retention');
  } catch {
    relay.error = 'Scheduled maintenance could not start; check storage availability';
    console.error(relay.error);
  }
}
const sweep = setInterval(scheduledSweep, 300000);
const firstSweep = setTimeout(scheduledSweep, 10000);

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  relay.closing = true;
  clearInterval(sweep);
  clearInterval(policySync);
  clearTimeout(firstSweep);
  const force = setTimeout(() => process.exit(code || 1), 55000);
  force.unref();
  try {
    await metrics.stop();
    await reviews?.stop();
    await relay.syncing;
    await relay.job;
    await relay.stop();
    await app.close();
    await reporting.close();
    await relay.counting;
    store.close();
    await rm(socket, { force: true });
  } catch (error) {
    console.error('Shutdown could not finish cleanly:', error.message);
    code = 1;
    await relay.stop();
  }
  process.exit(code);
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
