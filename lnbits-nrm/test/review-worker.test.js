import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { ReloadedPolicy as Policy } from './policy-helper.js';
import { ReviewWorker } from '../server/review-worker.js';
import { accessReason } from '../server/config.js';

const author = 'a'.repeat(64);
const event = n => ({ id: n.toString(16).padStart(64, '0'), pubkey: author, created_at: Math.floor(Date.now() / 1000), content: 'note', tags: [], kind: 1 });
function fixture(t, status = 'block', changes = {}) {
  const store = new Store(':memory:');
  store.saveSettings({ ...store.settings(), moderation: { ...store.settings().moderation, provider: 'aedos', oracleUrl: 'http://localhost:1234', ...changes } });
  const removed = [];
  const relay = { child: true, busy: false, hasEvent: async () => true, removeReviewed: async id => { removed.push(id); return true; } };
  const moderator = { review: async () => ({ status, reason: status, labels: [] }) };
  const worker = new ReviewWorker(store, moderator, relay);
  t.after(() => store.close());
  return { store, relay, moderator, worker, removed, policy: new Policy(store) };
}

test('a slow AI review never holds up the next publishing decision', async t => {
  const { store, worker, moderator, policy, removed } = fixture(t);
  let finish;
  moderator.review = () => new Promise(resolve => { finish = resolve; });
  assert.equal((await policy.decide({ type: 'new', event: event(1) })).action, 'accept');
  store.enqueueReview(event(1)); // Background collector, after publishing.
  const reviewing = worker.tick(Date.now() + 2000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finish, 'function');
  assert.equal((await policy.decide({ type: 'new', event: event(2) })).action, 'accept');
  store.enqueueReview(event(2));
  assert.equal(store.reviewCount(), 2);
  assert.deepEqual(removed, []);
  finish({ status: 'block', reason: 'blocked', labels: [] });
  await reviewing;
  assert.deepEqual(removed, [event(1).id]);
  assert.equal(store.reviewCount(), 1);
  assert.deepEqual(store.settings().block, [], 'auto-ban defaults off');
});

test('verdicts remove or keep notes; provider errors never auto-ban authors', async t => {
  for (const status of ['safe', 'warn', 'block', 'error', 'unknown']) {
    for (const permissive of [true, false]) {
      const { store, worker, removed } = fixture(t, status, { autoBan: true, blockWarnings: !permissive, failurePolicy: permissive ? 'accept' : 'reject' });
      store.enqueueReview(event(1), 0);
      await worker.tick(2000);
      const offending = status === 'block' || (status === 'warn' && !permissive);
      const remove = offending || (['error', 'unknown'].includes(status) && !permissive);
      assert.equal(removed.length, Number(remove), `${status}, permissive=${permissive}`);
      assert.deepEqual(store.settings().block, offending ? [author] : []);
      assert.equal(store.reviewCount(), 0);
    }
  }
});

test('auto-ban preserves allow-list authority and concurrent admin edits are not overwritten', async t => {
  const { store, worker, moderator } = fixture(t, 'block', { autoBan: true });
  store.saveSettings({ ...store.settings(), allow: [author] });
  store.enqueueReview(event(1), 0);
  await worker.tick(2000);
  assert.ok(store.settings().block.includes(author));
  assert.equal(accessReason(store.settings(), author), null);
  assert.ok(store.decisions()[0].labels.includes('allow-list-priority'));
  store.enqueueReview(event(2), 0);
  moderator.review = async () => {
    store.saveSettings({ ...store.settings(), moderation: { ...store.settings().moderation, autoBan: false } });
    return { status: 'block', reason: 'block', labels: [] };
  };
  await worker.tick(2000);
  assert.equal(store.reviewCount(), 1, 'stale verdict is retried with current policy');
});

test('deletion failures preserve the verdict, survive restart, and retry without another AI call', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lnbits-nrm-review-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'db');
  let store = new Store(path);
  store.saveSettings({ ...store.settings(), moderation: { ...store.settings().moderation, provider: 'aedos', oracleUrl: 'http://localhost:1234' } });
  store.enqueueReview(event(1), 0);
  let calls = 0;
  const moderator = { review: async () => { calls++; return { status: 'block', labels: [], reason: 'block' }; } };
  const relay = { child: true, busy: false, hasEvent: async () => true, removeReviewed: async () => { throw Error('disk busy'); } };
  await assert.rejects(new ReviewWorker(store, moderator, relay).tick(2000), /disk busy/);
  store.close(); store = new Store(path);
  assert.equal(store.reviewCount(), 1);
  relay.removeReviewed = async () => true;
  await new ReviewWorker(store, moderator, relay).tick(8000);
  assert.equal(calls, 1);
  assert.equal(store.reviewCount(), 0);
  store.close();
});

test('clear-all cancels an in-flight review without deleting or banning afterwards', async t => {
  const { store, worker, moderator, removed } = fixture(t, 'block', { autoBan: true });
  store.enqueueReview(event(1), 0);
  moderator.review = async () => { store.clearReviews(); return { status: 'block', labels: [], reason: 'block' }; };
  await worker.tick(2000);
  assert.deepEqual(removed, []);
  assert.deepEqual(store.settings().block, []);
});

test('wait for committed events, pause for maintenance, and discard stale missing events', async t => {
  const { store, worker, relay, removed } = fixture(t);
  store.enqueueReview(event(1), 0);
  relay.busy = true;
  await worker.tick(2000);
  assert.equal(store.reviewCount(), 1);
  relay.busy = false; relay.hasEvent = async () => false;
  await worker.tick(2000);
  assert.equal(store.reviewCount(), 1);
  assert.deepEqual(removed, []);
  await worker.tick(301000);
  assert.equal(store.reviewCount(), 0);
  assert.ok(store.decisions()[0].labels.includes('review-skipped'));
});

test('turning moderation off cancels queued reviews without removing notes', async t => {
  const { store, worker, removed } = fixture(t);
  store.enqueueReview(event(1), 0);
  store.saveSettings({ ...store.settings(), moderation: { ...store.settings().moderation, provider: 'off' } });
  await worker.tick(2000);
  assert.equal(store.reviewCount(), 0);
  assert.deepEqual(removed, []);
});

test('queue is deduplicated and bounded; full queues never reject relay publishing', async t => {
  const { store, policy } = fixture(t);
  store.db.exec('BEGIN');
  for (let i = 0; i < 10000; i++) assert.equal(store.enqueueReview(event(i), 0), true);
  store.db.exec('COMMIT');
  assert.equal(store.enqueueReview(event(1), 0), true);
  assert.equal(store.reviewCount(), 10000);
  assert.equal(store.enqueueReview(event(10001)), false);
  assert.equal((await policy.decide({ type: 'new', event: event(10001) })).action, 'accept');
});

test('older saved moderation policies migrate with auto-ban disabled', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lnbits-nrm-ban-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'db');
  let store = new Store(path);
  const settings = store.settings(); delete settings.moderation.autoBan;
  store.set('settings', settings); store.set('oracleKey', 'preserved'); store.close();
  store = new Store(path);
  assert.equal(store.settings().moderation.autoBan, false);
  assert.equal(store.settings().revision, settings.revision + 1);
  assert.equal(store.get('oracleKey'), 'preserved');
  store.close();
});

test('provider labels cannot turn an unavailable review into a bannable offense', async t => {
  const { store, worker, moderator } = fixture(t, 'error', { autoBan: true });
  moderator.review = async () => ({ status: 'error', reason: 'unavailable', labels: ['offending', 'auto-banned'] });
  store.enqueueReview(event(1), 0);
  await worker.tick(2000);
  assert.deepEqual(store.settings().block, []);
  assert.deepEqual(store.decisions()[0].labels, ['review-unavailable']);
});

test('a full ban list does not prevent removal and is reported in Activity', async t => {
  const { store, worker, removed } = fixture(t, 'block', { autoBan: true });
  store.saveSettings({ ...store.settings(), block: Array.from({ length: 10000 }, (_, i) => i.toString(16).padStart(64, '0')) });
  store.enqueueReview(event(1), 0);
  await worker.tick(2000);
  assert.equal(removed.length, 1);
  assert.equal(store.settings().block.length, 10000);
  assert.ok(store.decisions()[0].labels.includes('ban-list-full'));
});
