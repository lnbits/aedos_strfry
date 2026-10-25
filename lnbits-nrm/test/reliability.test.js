import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { ReloadedPolicy as Policy } from './policy-helper.js';
import { Reporting } from '../server/reporting.js';
import { Relay } from '../server/relay.js';
import { createApp } from '../server/api.js';

const event = { id: 'a'.repeat(64), pubkey: 'b'.repeat(64), kind: 1, created_at: Math.floor(Date.now() / 1000), content: 'test', tags: [] };
function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  return store;
}

test('Activity persistence failure cannot block policy enforcement', async t => {
  const store = fixture(t), policy = new Policy(store), reporting = new Reporting(store);
  store.db.exec("CREATE TRIGGER fail_counter BEFORE INSERT ON state WHEN NEW.key='counters' BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END");
  assert.equal(policy.decide({ type: 'new', event }).action, 'accept');
  reporting.receive({ event, action: 'accept', reason: 'Accepted', labels: [], bytes: 100 });
  assert.throws(() => reporting.flush(), /injected storage failure/);
  assert.equal(store.decisions().length, 0);
  assert.equal(store.get('counters'), undefined);
  assert.equal(policy.decide({ type: 'new', event }).action, 'accept');
  store.saveSettings({ ...store.settings(), block: [event.pubkey] });
  assert.equal(policy.decide({ type: 'new', event }).action, 'reject');
  store.db.exec('DROP TRIGGER fail_counter');
  reporting.flush();
  assert.equal(store.get('counters').accept, 1);
});

test('background Activity stays bounded and counters retain totals', t => {
  const store = fixture(t);
  store.db.exec('BEGIN');
  store.recordMany(Array.from({ length: 10250 }, () => ({ event, action: 'accept', reason: 'Accepted' })));
  store.db.exec('COMMIT');
  assert.equal(store.decisions(20000).length, 10000);
  assert.equal(store.get('counters').accept, 10250);
});

test('maintenance persistence failures release the busy flag and remain recoverable', async t => {
  const store = fixture(t);
  const relay = new Relay(store, { dataDir: '/unused' });
  relay.refreshCount = async () => {};
  const set = store.set.bind(store);
  store.set = () => { throw new Error('injected failure'); };
  assert.throws(() => relay.maintenance('retention'), /injected failure/);
  assert.equal(relay.busy, false);
  store.set = (key, value) => { if (value.status === 'complete') throw new Error('injected failure'); set(key, value); };
  relay.maintenance('retention');
  await relay.job;
  assert.equal(relay.busy, false);
  assert.match(relay.error, /maintenance status/);
  store.set = set;
  relay.maintenance('retention');
  await relay.job;
  assert.equal(store.get('maintenance').status, 'complete');
});

test('failed deletion reports failure and does not strand maintenance', async t => {
  const store = fixture(t);
  store.saveSettings({ ...store.settings(), retentionDays: 1 });
  const relay = new Relay(store, { dataDir: '/unused' });
  relay.refreshCount = async () => {};
  relay.command = async (args, onLine) => {
    if (args[0] === 'scan') await onLine(JSON.stringify({ ...event, created_at: 1 }));
    else throw new Error('injected delete failure');
  };
  relay.maintenance('retention');
  await relay.job;
  assert.equal(relay.busy, false);
  assert.equal(store.get('maintenance').status, 'error');
  assert.match(store.get('maintenance').error, /delete failure/);
});

test('health probes coalesce and stopped relays cannot appear healthy from cache', async t => {
  const store = fixture(t), relay = new Relay(store, { dataDir: '/unused' });
  relay.child = {};
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('{}'); });
  assert.ok((await Promise.all(Array.from({ length: 100 }, () => relay.online()))).every(Boolean));
  assert.equal(calls, 1);
  relay.stopping = true;
  assert.equal(await relay.online(), false);
});

test('stopped-by-signal child and shutdown clear completion cannot hang or restart relay', async t => {
  const store = fixture(t), relay = new Relay(store, { dataDir: '/unused' });
  relay.child = { pid: 123, exitCode: null, signalCode: 'SIGTERM' };
  await relay.stop();
  relay.child = null;
  relay.closing = true;
  relay.start();
  assert.equal(relay.child, null);
});

test('SQLite connection still closes when traffic flush fails', () => {
  const store = new Store(':memory:');
  store.traffic.flush = () => { throw new Error('injected flush failure'); };
  assert.throws(() => store.close(), /flush failure/);
  assert.throws(() => store.db.prepare('SELECT 1'), /not open/);
});

test('unauthenticated login payloads are bounded and repeated auth requests are throttled', async t => {
  const store = fixture(t);
  const origin = 'https://example.test';
  const app = await createApp({ store, relay: {}, admins: [event.pubkey], origin, dist: '/unused' });
  t.after(() => app.close());
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { event: 'x'.repeat(9000) } })).statusCode, 413);
  for (let i = 1; i < 60; i++) assert.equal((await app.inject('/api/auth/session')).statusCode, 200);
  assert.equal((await app.inject('/api/auth/session')).statusCode, 429);
  assert.equal((await app.inject({ url: '/api/auth/session', remoteAddress: '192.0.2.1' })).statusCode, 200);
});


test('health reports a known write-policy failure even when strfry is online', async t => {
  const store = fixture(t), relay = { online: async () => true, policyError: 'storage failed' };
  const app = await createApp({ store, relay, admins: [], origin: 'https://example.test', dist: '/unused' });
  t.after(() => app.close());
  assert.equal((await app.inject('/api/health')).statusCode, 503);
  relay.policyError = null;
  assert.equal((await app.inject('/api/health')).statusCode, 200);
});

test('in-memory quotas are ordered, bounded and retain usage across rule edits', t => {
  const store = fixture(t), policy = new Policy(store);
  store.saveSettings({ ...store.settings(), rate: { perMinute: 2, perHour: 2 } });
  assert.deepEqual(Array.from({ length: 4 }, () => policy.decide({ type: 'new', event }).action), ['accept', 'accept', 'reject', 'reject']);
  assert.equal(store.get('counters'), undefined);
  assert.equal(store.decisions().length, 0);
  store.saveSettings({ ...store.settings(), wordFilter: { allow: [], block: ['other'] } });
  assert.equal(policy.decide({ type: 'new', event }).action, 'reject');
});
