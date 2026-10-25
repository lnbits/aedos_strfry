import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { Store } from '../server/store.js';
import { ReloadedPolicy as Policy } from './policy-helper.js';
import { Reporting } from '../server/reporting.js';
import { Auth } from '../server/auth.js';
import { createApp } from '../server/api.js';

const minute = 60000;
function fixture(t) { const store = new Store(':memory:'); t.after(() => store.close()); return store; }

test('traffic merges pending and persisted minute buckets without double counting', t => {
  const store = fixture(t), traffic = store.traffic;
  const now = Math.floor(Date.now() / minute) * minute + 2000;
  traffic.record('accept', 100, now - minute);
  traffic.record('reject', 200, now - 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM traffic_minutes').get().n, 0, 'publishing does not write traffic rows');
  let result = traffic.snapshot('1h', now);
  assert.equal(result.points.length, 60);
  assert.deepEqual(result.points.at(-2), { at: now - 2000 - minute, accept: 1, reject: 0, bytes: 100 });
  assert.deepEqual(result.points.at(-1), { at: now - 2000, accept: 0, reject: 1, bytes: 200 });
  assert.deepEqual(result.totals, { accept: 1, reject: 1, bytes: 300 });
  traffic.flush(now);
  assert.deepEqual(traffic.snapshot('1h', now), result);
  traffic.record('accept', 50, now);
  result = traffic.snapshot('1h', now);
  assert.deepEqual(result.totals, { accept: 2, reject: 1, bytes: 350 });
  traffic.flush(now);
  traffic.flush(now);
  assert.deepEqual(traffic.snapshot('1h', now).totals, result.totals);
  assert.equal(result.points.filter(p => p.accept || p.reject).length, 2);
});

test('traffic ranges aggregate correctly, include boundary intervals and exclude older/future data', t => {
  const traffic = fixture(t).traffic;
  const now = Math.floor(Date.now() / minute) * minute;
  for (const [range, step, count] of [['1h', minute, 60], ['24h', 15 * minute, 96], ['7d', 60 * minute, 168], ['30d', 240 * minute, 180]]) {
    traffic.pending.clear();
    const first = Math.floor(now / step) * step - (count - 1) * step;
    traffic.record('accept', 10, first - minute);
    traffic.record('accept', 20, first);
    traffic.record('reject', 30, now);
    traffic.record('accept', 40, now + step);
    const result = traffic.snapshot(range, now);
    assert.equal(result.points.length, count);
    assert.equal(result.step, step);
    assert.equal(result.from, first);
    assert.deepEqual(result.totals, { accept: 1, reject: 1, bytes: 50 });
    traffic.flush(now);
    assert.deepEqual(traffic.snapshot(range, now).totals, result.totals);
    traffic.db.exec('DELETE FROM traffic_minutes');
  }
  for (const range of ['', 'forever', '__proto__', 'constructor', ['1h', '7d']]) assert.throws(() => traffic.snapshot(range, now), { statusCode: 400 });
});

test('traffic history survives restart and is separate from reviews and note clearing', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lnbits-nrm-traffic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'db');
  let store = new Store(path);
  const startedAt = store.traffic.startedAt;
  store.traffic.record('accept', 200);
  store.close();
  store = new Store(path);
  t.after(() => store.close());
  assert.equal(store.traffic.startedAt, startedAt);
  assert.deepEqual(store.traffic.snapshot().totals, { accept: 1, reject: 0, bytes: 200 });
  store.clearReviews();
  store.cleanup();
  assert.deepEqual(store.traffic.snapshot().totals, { accept: 1, reject: 0, bytes: 200 });
});

test('traffic keeps only 30 days and failed flushes retain a retryable, atomic batch', t => {
  const store = fixture(t), traffic = store.traffic;
  const now = Math.floor(Date.now() / minute) * minute;
  const cutoff = now - 30 * 86400000;
  store.db.prepare('INSERT INTO traffic_minutes VALUES (?,?,?,?)').run(cutoff - minute, 4, 5, 600);
  traffic.record('accept', 10, cutoff - minute);
  traffic.record('accept', 20, cutoff);
  traffic.record('reject', 30, now);
  store.db.exec(`CREATE TRIGGER fail_traffic BEFORE INSERT ON traffic_minutes WHEN NEW.reject > 0 BEGIN SELECT RAISE(ABORT, 'disk failure'); END;`);
  assert.throws(() => traffic.flush(now), /disk failure/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM traffic_minutes').get().n, 1, 'partial batch rolled back');
  assert.equal(traffic.pending.size, 2, 'unexpired counters retained');
  store.db.exec('DROP TRIGGER fail_traffic');
  traffic.flush(now);
  assert.equal(traffic.pending.size, 0);
  assert.deepEqual(store.db.prepare('SELECT at FROM traffic_minutes ORDER BY at').all().map(row => row.at), [cutoff, now]);
});

test('policy traffic measures UTF-8 event JSON once and excludes malformed requests and review outcomes', async t => {
  const store = fixture(t), policy = new Policy(store), reporting = new Reporting(store);
  const event = { id: 'a'.repeat(64), pubkey: 'b'.repeat(64), created_at: Math.floor(Date.now() / 1000), content: 'hello ⚡', tags: [], kind: 1 };
  assert.equal((await policy.decide({ type: 'new', event })).action, 'accept');
  reporting.receive({ event, action: 'accept', reason: 'Accepted', labels: [], bytes: Buffer.byteLength(JSON.stringify(event)) });
  store.saveSettings({ ...store.settings(), block: [event.pubkey] });
  assert.equal((await policy.decide({ type: 'new', event })).action, 'reject');
  reporting.receive({ event, action: 'reject', reason: 'Blocked', labels: [], bytes: Buffer.byteLength(JSON.stringify(event)) });
  assert.equal(store.traffic.snapshot().totals.accept, 0);
  reporting.flush();
  await policy.decide({ type: 'invalid', event });
  store.record(event, 'review', 'safe');
  store.record(event, 'remove', 'removed');
  const result = store.traffic.snapshot();
  assert.deepEqual(result.totals, { accept: 1, reject: 1, bytes: 2 * Buffer.byteLength(JSON.stringify(event)) });
  for (const privateValue of [event.id, event.pubkey, event.content]) assert.equal(JSON.stringify(result).includes(privateValue), false);
});

test('traffic API requires an admin session and validates ranges', async t => {
  const store = new Store(':memory:');
  const secret = new Uint8Array(32).fill(1), key = getPublicKey(secret), origin = 'https://lnbits-nrm.test';
  const app = await createApp({ store, relay: {}, admins: [key], origin, dist: '/does-not-exist' });
  t.after(async () => { await app.close(); store.close(); });
  assert.equal((await app.inject('/api/traffic')).statusCode, 401);
  const auth = new Auth(store, [key], origin), challenge = auth.challenge();
  const cookies = { aedos_session: auth.login(challenge.token, finalizeEvent(challenge.event, secret)) };
  store.traffic.record('accept', 100);
  for (const range of ['1h', '24h', '7d', '30d']) {
    const response = await app.inject({ url: `/api/traffic?range=${range}`, cookies });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.json().range, range);
    assert.deepEqual(response.json().totals, { accept: 1, reject: 0, bytes: 100 });
  }
  for (const query of ['range=nope', 'range=__proto__', 'range=1h&range=7d']) assert.equal((await app.inject({ url: `/api/traffic?${query}`, cookies })).statusCode, 400);
});
