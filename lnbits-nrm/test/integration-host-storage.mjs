// Actual Compose host-storage lifecycle, isolated from operator data and projects.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, stat, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';

const exec = promisify(execFile), root = resolve('..');
const temp = await mkdtemp(join(tmpdir(), 'lnbits-nrm-host-'));
const settingsDir = join(temp, 'settings'), databaseDir = join(temp, 'database');
const envFile = join(temp, 'test.env'), project = `lnbits-nrm-host-${process.pid}`;
const freePort = () => new Promise(done => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => done(port)); }); });
const uiPort = await freePort(), relayPort = await freePort();
const origin = `http://127.0.0.1:${uiPort}`, relayUrl = `ws://127.0.0.1:${relayPort}`;
const secret = new Uint8Array(32).fill(1), key = getPublicKey(secret);
const identity = getPublicKey(new Uint8Array(32).fill(2));
const env = { ...process.env, RELAY_PUBKEY: nip19.npubEncode(identity), RELAY_CONTACT: 'mailto:relay@example.com', NRM_DATA_DIR: settingsDir, STRFRY_DB_DIR: databaseDir, ADMIN_NPUBS: key,
  PUBLIC_ORIGIN: origin, RELAY_URL: relayUrl, UI_BIND: '127.0.0.1', RELAY_BIND: '127.0.0.1',
  UI_PORT: String(uiPort), RELAY_PORT: String(relayPort), AI_MODERATION_ENABLED: 'false', REQUIRE_EXISTING_DB: 'false' };
await writeFile(envFile, '', { mode: 0o600 });
const docker = async (...args) => (await exec('docker', args, { env, maxBuffer: 1024 * 1024 })).stdout.trim();
const compose = (...args) => docker('compose', '--project-directory', root, '--env-file', envFile,
  '-p', project, '-f', join(root, 'compose.yaml'), '-f', join(root, 'compose.host.yaml'), ...args);
const pause = ms => new Promise(done => setTimeout(done, ms));
async function healthy() {
  for (let i = 0; i < 150; i++) { try { if ((await fetch(origin + '/api/health')).ok) return; } catch {} await pause(200); }
  throw new Error('Relay failed health check');
}
async function rejects(command, pattern) {
  try { await command(); assert.fail('Command should have failed'); }
  catch (error) { assert.match(`${error.stderr ?? ''}${error.stdout ?? ''}`, pattern); }
}
const cookies = new Map();
async function request(path, method = 'GET', body) {
  const response = await fetch(origin + '/api' + path, { method, headers: { origin, 'content-type': 'application/json', cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; ') }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const item of response.headers.getSetCookie()) { const [k,v] = item.split(';')[0].split('='); cookies.set(k,v); }
  const data = await response.json();
  assert.ok(response.ok, JSON.stringify(data));
  return data;
}
async function publish(event) {
  return new Promise((done, reject) => {
    const ws = new WebSocket(relayUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error('Publish timed out')); }, 10000);
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]));
    ws.onerror = error => { clearTimeout(timer); reject(error); };
    ws.onmessage = ({ data }) => { const reply = JSON.parse(data); if (reply[0] === 'OK' && reply[1] === event.id) { clearTimeout(timer); ws.close(); done(reply[2]); } };
  });
}
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');

try {
  const config = JSON.parse(await compose('config', '--format', 'json'));
  assert.equal(config.services.aedos.volumes.find(v => v.target === '/data').type, 'bind');
  assert.equal(config.services.aedos.volumes.find(v => v.target === '/data/strfry-db').source, databaseDir);
  await rejects(() => compose('create', 'aedos'), /bind source path does not exist/);
  await compose('run', '--rm', 'setup');
  for (const dir of [settingsDir, databaseDir]) {
    assert.equal((await stat(dir)).uid, 1000);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  }
  env.REQUIRE_EXISTING_DB = 'true';
  await rejects(() => compose('run', '--rm', 'setup'), /REQUIRE_EXISTING_DB/);
  await rejects(() => compose('run', '--rm', '--no-deps', 'aedos'), /REQUIRE_EXISTING_DB/);
  assert.deepEqual(await readdir(databaseDir), []);
  assert.deepEqual((await readdir(settingsDir)).filter(name => name.endsWith('.sqlite')), []);
  console.log('PASS host initialization and missing-database guards leave existing data untouched');

  env.REQUIRE_EXISTING_DB = 'false';
  await compose('up', '-d', '--no-build', 'aedos');
  await healthy();
  const metadata = await (await fetch(relayUrl.replace('ws:', 'http:'), { headers: { accept: 'application/nostr+json' } })).json();
  assert.equal(metadata.pubkey, identity, 'relay identity is independent of the operator key');
  assert.equal(metadata.contact, 'mailto:relay@example.com');
  const container = await compose('ps', '-q', 'aedos');
  const mounts = JSON.parse(await docker('inspect', container, '--format', '{{json .Mounts}}'));
  assert.equal(mounts.find(m => m.Destination === '/data').Source, settingsDir);
  assert.equal(mounts.find(m => m.Destination === '/data/strfry-db').Source, databaseDir);
  const challenge = await request('/auth/challenge', 'POST', {});
  const session = await request('/auth/login', 'POST', { event: finalizeEvent(challenge.event, secret) });
  assert.equal(session.pubkey, key, 'metadata identity does not replace the authorized operator');
  console.log('PASS public relay identity and contact survive independently of admin access');
  let settings = await request('/settings');
  assert.equal(settings.retentionDays, 0);
  const note = finalizeEvent({ kind: 1, tags: [], content: 'host mount persistence test', created_at: Math.floor(Date.now() / 1000) - 60 * 86400 }, secret);
  assert.equal(await publish(note), true);
  const { aiModerationEnabled, openaiKeySet, oracleKeySet, ...writable } = settings;
  await request('/settings', 'PUT', { ...writable, wordFilter: { block: ['blockedword'], allow: [] } });
  await compose('down');
  const database = join(databaseDir, 'data.mdb'), settingsDb = join(settingsDir, 'lnbits-nrm.sqlite');
  assert.ok((await stat(database)).size > 0);
  assert.ok((await stat(settingsDb)).size > 0);
  const before = await hash(database);
  env.REQUIRE_EXISTING_DB = 'true';
  await compose('run', '--rm', 'setup');
  assert.equal(await hash(database), before);
  await chmod(database, 0o400);
  await rejects(() => compose('run', '--rm', 'setup'), /Storage setup failed/);
  assert.equal((await stat(database)).mode & 0o777, 0o400, 'setup does not change existing file permissions');
  assert.equal(await hash(database), before);
  await chmod(database, 0o600);
  console.log('PASS setup preserves imported files and reports permissions instead of rewriting them');

  await compose('up', '-d', '--no-build', 'aedos');
  await healthy();
  assert.equal((await request('/auth/session')).authenticated, true);
  settings = await request('/settings');
  assert.deepEqual(settings.wordFilter.block, ['blockedword']);
  assert.equal(settings.retentionDays, 0);
  assert.equal(Number(await compose('exec', '-T', 'aedos', 'strfry', '--config', '/data/strfry.conf', 'scan', '--count', JSON.stringify({ ids: [note.id] }))), 1);
  console.log('PASS real relay notes, sessions and manager settings survive Compose down/up on host directories');
  console.log('All host-storage integration checks passed.');
} catch (error) {
  console.error(await compose('logs', '--tail', '30', 'aedos').catch(() => 'No logs'));
  throw error;
} finally {
  await compose('down', '-v', '--remove-orphans').catch(() => {});
  // Remove only this test's generated directory, including any root-created setup paths.
  await docker('run', '--rm', '--user', '0:0', '--network', 'none', '--mount', `type=bind,src=${temp},dst=/cleanup`,
    '--entrypoint', 'node', 'lnbits-nrm:local', '--input-type=module', '-e', "import {readdir,rm} from 'node:fs/promises'; for(const name of await readdir('/cleanup')) await rm('/cleanup/'+name,{recursive:true,force:true});").catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
