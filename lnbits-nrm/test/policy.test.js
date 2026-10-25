import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPublicKey, nip19 } from 'nostr-tools';
import { defaults, settingsSchema, expired, pubkey } from '../server/config.js';
import { Store } from '../server/store.js';
import { ReloadedPolicy as Policy } from './policy-helper.js';
import { Relay } from '../server/relay.js';

const a = getPublicKey(new Uint8Array(32).fill(1));
const b = getPublicKey(new Uint8Array(32).fill(2));
const c = getPublicKey(new Uint8Array(32).fill(3));
const event = (author = a, age = 0) => ({ id: 'e'.repeat(64), pubkey: author, created_at: Math.floor(Date.now() / 1000) - age, content: 'hello', tags: [], kind: 1 });
function fixture(t, change = {}) {
  const store = new Store(':memory:');
  store.saveSettings({ ...structuredClone(defaults), revision: 0, ...change });
  t.after(() => store.close());
  return { store, policy: new Policy(store) };
}

test('npubs normalize and private or malformed keys are rejected', () => {
  assert.equal(pubkey(nip19.npubEncode(a)), a);
  assert.equal(pubkey(a.toUpperCase()), a);
  assert.throws(() => pubkey(nip19.nsecEncode(new Uint8Array(32).fill(1))));
  assert.throws(() => pubkey('npub1invalid'));
});
test('empty lists permit authors; allow list overrides block list and excludes everyone else', async t => {
  const { store, policy } = fixture(t);
  assert.equal((await policy.decide({ type: 'new', event: event() })).action, 'accept');
  store.saveSettings({ ...store.settings(), allow: [a], block: [a, b] });
  assert.equal((await policy.decide({ type: 'new', event: event(a) })).action, 'accept');
  assert.equal((await policy.decide({ type: 'new', event: event(b) })).action, 'reject');
  assert.equal((await policy.decide({ type: 'new', event: event(c) })).action, 'reject');
  store.saveSettings({ ...store.settings(), allow: [] });
  assert.equal((await policy.decide({ type: 'new', event: event(a) })).action, 'reject');
  assert.equal((await policy.decide({ type: 'new', event: event(c) })).action, 'accept');
});
test('fresh settings keep old notes and retention cleanup issues no scan or delete commands', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  assert.equal(store.settings().retentionDays, 0);
  assert.deepEqual(store.settings().retentionOverrides, []);
  assert.equal((await new Policy(store).decide({ type: 'new', event: event(a, 3650 * 86400) })).action, 'accept');
  const relay = new Relay(store, { dataDir: '/unused' });
  const commands = [];
  relay.command = async args => { commands.push(args); return ''; };
  relay.refreshCount = async () => {};
  relay.maintenance('retention');
  await relay.job;
  assert.equal(store.get('maintenance').status, 'complete');
  assert.equal(store.get('maintenance').deleted, 0);
  assert.deepEqual(commands, [], 'default cleanup never scans or deletes events');
});

test('retention honors longer, shorter and unlimited overrides at the cutoff', () => {
  const s = { ...defaults, retentionDays: 30, retentionOverrides: [{ pubkey: a, days: 90 }, { pubkey: b, days: 0 }, { pubkey: c, days: 1 }] };
  const now = 2000000000;
  assert.equal(expired({ pubkey: a, created_at: now - 60 * 86400 }, s, now), false);
  assert.equal(expired({ pubkey: a, created_at: now - 90 * 86400 }, s, now), true);
  assert.equal(expired({ pubkey: b, created_at: 1 }, s, now), false);
  assert.equal(expired({ pubkey: c, created_at: now - 86400 }, s, now), true);
  assert.equal(expired({ pubkey: 'd'.repeat(64), created_at: now - 31 * 86400 }, s, now), true);
});
test('expired incoming events are never queued for moderation', async t => {
  const { store, policy } = fixture(t, { retentionDays: 30, moderation: { ...defaults.moderation, provider: 'aedos', oracleUrl: 'http://localhost:1234' } });
  assert.equal((await policy.decide({ type: 'new', event: event(a, 31 * 86400) })).action, 'reject');
  assert.equal(store.reviewCount(), 0);
});
test('minute and hour quotas are author-specific and reset independently', t => {
  const { policy } = fixture(t);
  const rate = { perMinute: 1, perHour: 2 };
  assert.equal(policy.takeRate(a, rate, 3600), true);
  assert.equal(policy.takeRate(a, rate, 3601), false);
  assert.equal(policy.takeRate(b, rate, 3601), true);
  assert.equal(policy.takeRate(a, rate, 3660), true);
  assert.equal(policy.takeRate(a, rate, 3720), false);
  assert.equal(policy.takeRate(a, rate, 7200), true);
  assert.equal(policy.takeRate(a, { perMinute: 0, perHour: 0 }, 7201), true);
});
test('settings persist but plugin quotas reset on restart', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lnbits-nrm-store-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'db');
  let store = new Store(path);
  store.saveSettings({ ...store.settings(), allow: [a], retentionDays: 30, retentionOverrides: [{ pubkey: b, days: 7 }] });
  let policy = new Policy(store);
  policy.takeRate(a, { perMinute: 1, perHour: 0 }, 120);
  store.close(); store = new Store(path);
  assert.deepEqual(store.settings().allow, [a]);
  assert.equal(store.settings().retentionDays, 30, 'saved retention is preserved on startup');
  assert.deepEqual(store.settings().retentionOverrides, [{ pubkey: b, days: 7 }]);
  policy = new Policy(store);
  assert.equal(policy.takeRate(a, { perMinute: 1, perHour: 0 }, 121), true);
  store.close();
});
test('enabled moderation does not enqueue or persist anything in the publishing decision', async t => {
  const { store, policy } = fixture(t, { moderation: { ...defaults.moderation, provider: 'aedos', oracleUrl: 'http://localhost:1234' } });
  assert.equal((await policy.decide({ type: 'new', event: event() })).action, 'accept');
  assert.equal(store.reviewCount(), 0);
  assert.equal(store.decisions().length, 0);
});
test('invalid configuration and conflicting updates are rejected; secrets never returned', t => {
  const { store } = fixture(t);
  assert.throws(() => settingsSchema.parse({ ...defaults, rate: { perMinute: -1, perHour: 0 } }));
  assert.throws(() => settingsSchema.parse({ ...defaults, retentionOverrides: [{ pubkey: a, days: 1 }, { pubkey: a, days: 2 }] }));
  assert.throws(() => store.saveSettings({ ...defaults, revision: 0 }), /another session/);
  store.saveSettings({ ...store.settings(), openaiKey: 'secret-test-key' });
  assert.equal(store.publicSettings().openaiKeySet, true);
  assert.equal(JSON.stringify(store.publicSettings()).includes('secret-test-key'), false);
  assert.throws(() => store.saveSettings({ ...store.settings(), openaiKey: '', moderation: { ...defaults.moderation, provider: 'openai' } }), /API key/);
});
