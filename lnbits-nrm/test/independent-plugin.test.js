import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { defaults } from '../server/config.js';
import { Policy, needsPlugin } from '../server/policy.js';
import { Store } from '../server/store.js';
import { Reporting, parseMetrics, RelayMetrics } from '../server/reporting.js';

const event = { id: 'a'.repeat(64), pubkey: 'b'.repeat(64), created_at: 2000000000, content: 'hello ⚡', tags: [], kind: 1 };
const settings = () => structuredClone({ ...defaults, rate: { perMinute: 0, perHour: 0 } });
function plugin(t, dir) {
  const child = spawn(process.execPath, [resolve('server/plugin.js')], { env: { ...process.env, DATA_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const replies = lines[Symbol.asyncIterator]();
  let stderr = ''; child.stderr.on('data', d => { stderr += d; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(r => child.once('exit', r)); child.kill(); await exited; } lines.close(); });
  return async (value = event) => {
    child.stdin.write(JSON.stringify({ type: 'new', event: value }) + '\n');
    let timer;
    try {
      const reply = await Promise.race([replies.next(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Plugin blocked: ' + stderr)), 2000); })]);
      assert.equal(reply.done, false, stderr); return JSON.parse(reply.value);
    } finally { clearTimeout(timer); }
  };
}

test('real plugin enforces and reloads rules without a manager, database, or reporting listener', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'nrm-plugin-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'policy.json');
  const write = s => { writeFileSync(file + '.next', JSON.stringify(s)); renameSync(file + '.next', file); };
  let s = settings(); write(s);
  const publish = plugin(t, dir);
  assert.equal((await publish()).action, 'accept');
  s.block = [event.pubkey]; write(s);
  assert.match((await publish()).msg, /block list/);
  s.allow = [event.pubkey]; write(s);
  assert.equal((await publish()).action, 'accept');
  s.rate.perMinute = 1; write(s);
  assert.equal((await publish()).action, 'accept');
  s.wordFilter.block = ['different']; write(s);
  assert.match((await publish()).msg, /rate-limited/, 'editing rules does not reset quotas');
  writeFileSync(file, '{');
  assert.match((await publish()).msg, /rules unavailable/);
  s.rate.perMinute = 0; s.wordFilter.block = ['hello']; write(s);
  assert.match((await publish()).msg, /banned word/);
  s.wordFilter.block = []; s.moderation.provider = 'aedos'; write(s);
  for (let i = 0; i < 100; i++) assert.equal((await publish()).action, 'accept', 'AI collection outage never blocks publishing');
});

test('plugin bypass requires every rule and AI to be disabled', () => {
  const s = settings(); assert.equal(needsPlugin(s), false);
  for (const change of [{ block: [event.pubkey] }, { allow: [event.pubkey] }, { retentionDays: 1 },
    { retentionOverrides: [{ pubkey: event.pubkey, days: 1 }] }, { rate: { perMinute: 1, perHour: 0 } },
    { wordFilter: { allow: [], block: ['x'] } }, { moderation: { ...s.moderation, provider: 'aedos' } }]) {
    assert.equal(needsPlugin({ ...s, ...change }), true);
  }
});

test('rate author map is bounded without evicting active quotas', () => {
  const policy = new Policy(settings(), { maxAuthors: 1 });
  const rate = { perMinute: 1, perHour: 2 };
  assert.equal(policy.takeRate('a', rate, 3600), true);
  assert.equal(policy.takeRate('b', rate, 3600), false);
  assert.equal(policy.takeRate('a', rate, 3660), true);
  assert.equal(policy.takeRate('a', rate, 3720), false);
  assert.equal(policy.takeRate('b', rate, 7200), true);
});

test('reporting is bounded, retries atomically, and AI queue saturation does not affect policy', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.saveSettings({ ...store.settings(), moderation: { ...defaults.moderation, provider: 'aedos', oracleUrl: 'http://localhost:1' } });
  const reporting = new Reporting(store);
  const row = { event, action: 'accept', reason: 'Accepted', labels: [], bytes: 200, review: true };
  reporting.receive(row);
  assert.equal(store.reviewCount(), 0);
  store.db.exec("CREATE TRIGGER report_fail BEFORE INSERT ON decisions BEGIN SELECT RAISE(ABORT, 'failed'); END");
  assert.throws(() => reporting.flush(), /failed/);
  assert.equal(store.reviewCount(), 0, 'queue insert rolls back with Activity');
  store.db.exec('DROP TRIGGER report_fail');
  reporting.flush();
  assert.equal(store.reviewCount(), 1); assert.equal(store.decisions().length, 1);
  store.enqueueReview = () => false;
  reporting.receive(row); reporting.flush();
  assert.match(reporting.warning, /queue full/);
  assert.equal(new Policy(store.settings()).decide({ type: 'new', event }).action, 'accept');
  for (let i = 0; i < 10001; i++) reporting.receive({ ...row, review: false });
  assert.equal(reporting.pending.length, 10000); assert.equal(reporting.dropped, 1);
  assert.match(reporting.warning, /buffer full/);
});

test('native metrics aggregate labels, persist background deltas and handle counter resets', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const metrics = new RelayMetrics(store);
  const body = n => `# HELP nostr_client_messages_total Messages\nnostr_client_messages_total{verb="EVENT"} ${n}\nnostr_client_messages_total{verb="REQ"} 1\nnostr_relay_messages_total{verb="OK"} ${n}\nnostr_events_total{kind="1"} ${n}\n`;
  assert.deepEqual(parseMetrics(body(5)), { received: 6, sent: 5, events: 5 });
  let n = 5;
  t.mock.method(globalThis, 'fetch', async () => new Response(body(n)));
  await metrics.tick(); n = 10; await metrics.tick();
  assert.deepEqual(store.traffic.snapshot().nativeTotals, { received: 11, sent: 10, events: 10 });
  n = 1; await metrics.tick(); store.traffic.flush();
  assert.deepEqual(store.traffic.snapshot().nativeTotals, { received: 13, sent: 11, events: 11 });
});

test('private reporting listener bounds frames and survives malformed clients', async t => {
  const { createConnection } = await import('node:net');
  const dir = mkdtempSync(join(tmpdir(), 'nrm-reporting-'));
  const store = new Store(':memory:');
  const reporting = new Reporting(store), path = join(dir, 'reporting.sock');
  await new Promise(resolve => reporting.server.listen(path, resolve));
  t.after(async () => { await reporting.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const connection = () => new Promise(resolve => { const socket = createConnection(path); socket.on('error', () => {}); socket.once('connect', () => resolve(socket)); });
  const bad = await connection();
  const closed = new Promise(resolve => bad.once('close', resolve));
  bad.write('x'.repeat(128 * 1024 + 1));
  await closed;
  assert.equal(reporting.pending.length, 0);
  const good = await connection();
  const row = { event, action: 'accept', reason: 'Accepted ⚡', labels: [], bytes: 200 };
  const frame = Buffer.from(JSON.stringify(row) + '\n');
  const split = frame.indexOf(Buffer.from('⚡')) + 1;
  good.write(frame.subarray(0, split));
  await new Promise(r => setImmediate(r));
  good.end(frame.subarray(split));
  await new Promise(resolve => good.once('close', resolve));
  reporting.flush();
  assert.equal(store.decisions()[0].reason, 'Accepted ⚡');
});
