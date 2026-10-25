import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { runtimeOptions } from '../server/config.js';
import { Store } from '../server/store.js';
import { ReloadedPolicy as Policy } from './policy-helper.js';
import { Moderator } from '../server/moderation.js';
import { ReviewWorker } from '../server/review-worker.js';
import { Auth } from '../server/auth.js';
import { createApp } from '../server/api.js';

const event = { id: 'a'.repeat(64), pubkey: 'b'.repeat(64), content: '#csam https://example.com/video.mp4', tags: [], created_at: Math.floor(Date.now() / 1000) };

test('deployment flag defaults to available and rejects ambiguous values', () => {
  assert.equal(runtimeOptions({}).aiModerationEnabled, true);
  for (const value of ['true', 'TRUE', ' 1 ']) assert.equal(runtimeOptions({ AI_MODERATION_ENABLED: value }).aiModerationEnabled, true);
  for (const value of ['false', 'FALSE', ' 0 ']) assert.equal(runtimeOptions({ AI_MODERATION_ENABLED: value }).aiModerationEnabled, false);
  for (const value of ['', 'yes', 'disabled', 'flase']) assert.throws(() => runtimeOptions({ AI_MODERATION_ENABLED: value }), /AI_MODERATION_ENABLED/);
});

test('operator disable overrides saved providers and clears pending verdicts without banning', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lnbits-nrm-ai-disabled-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'db');
  let store = new Store(path);
  store.saveSettings({ ...store.settings(), moderation: { ...store.settings().moderation, provider: 'aedos', oracleUrl: 'http://localhost:8787', autoBan: true }, oracleKey: 'retained-secret' });
  store.enqueueReview(event, 0);
  const revision = store.settings().revision;
  store.saveReviewResult(store.nextReview(2000).seq, { status: 'block', reason: 'block', labels: [] }, revision);
  store.close();
  store = new Store(path, { aiModerationEnabled: false });
  assert.equal(store.publicSettings().aiModerationEnabled, false);
  assert.equal(store.settings().moderation.provider, 'off');
  assert.equal(store.settings().moderation.autoBan, false);
  assert.equal(store.settings().revision, revision + 1);
  assert.equal(store.reviewCount(), 0);
  assert.deepEqual(store.settings().block, []);
  assert.equal(store.get('oracleKey'), 'retained-secret');
  assert.equal(JSON.stringify(store.publicSettings()).includes('retained-secret'), false);
  assert.throws(() => { store.aiModerationEnabled = true; }, TypeError);
  store.close();
  store = new Store(path);
  assert.equal(store.publicSettings().aiModerationEnabled, true);
  assert.equal(store.settings().moderation.provider, 'off', 'restoring capability does not automatically reactivate a saved provider');
  store.close();
});

test('disabled deployments never enqueue, call providers, download media, or start review polling', async t => {
  const store = new Store(':memory:', { aiModerationEnabled: false });
  t.after(() => store.close());
  // Even a stale or externally restored provider cannot bypass the runtime capability.
  const stale = { ...store.settings(), moderation: { ...store.settings().moderation, provider: 'openai', autoBan: true } };
  store.set('settings', stale);
  const moderator = new Moderator(store, {
    fetch: async () => { assert.fail('Provider must not be called'); },
    download: async () => { assert.fail('Media must not be downloaded'); }
  });
  assert.equal((await moderator.review(event, stale)).status, 'safe');
  assert.equal(store.enqueueReview(event), false);
  assert.equal((await new Policy(store).decide({ type: 'new', event })).action, 'accept');
  assert.equal(store.reviewCount(), 0);
  const worker = new ReviewWorker(store, moderator, { child: true, hasEvent: async () => assert.fail('Worker must not scan notes') });
  worker.start();
  assert.equal(worker.timer, null);
  assert.equal(worker.stopped, true);
  await worker.tick();
  await worker.stop();
});

test('non-AI rules remain editable and enforce author lists, words, rates and retention', async t => {
  const store = new Store(':memory:', { aiModerationEnabled: false });
  t.after(() => store.close());
  const policy = new Policy(store);
  store.saveSettings({ ...store.settings(), block: [event.pubkey] });
  assert.match((await policy.decide({ type: 'new', event })).msg, /block list/);
  store.saveSettings({ ...store.settings(), block: [], wordFilter: { allow: [], block: ['csam'] } });
  assert.match((await policy.decide({ type: 'new', event })).msg, /banned word/);
  store.saveSettings({ ...store.settings(), wordFilter: { allow: [], block: [] }, retentionDays: 1 });
  assert.match((await policy.decide({ type: 'new', event: { ...event, created_at: event.created_at - 172800 } })).msg, /retention/);
  store.saveSettings({ ...store.settings(), rate: { perMinute: 1, perHour: 1 } });
  assert.match((await policy.decide({ type: 'new', event })).msg, /rate-limited/);
  assert.equal(store.publicSettings().aiModerationEnabled, false);
});

test('authenticated administrators cannot enable either AI provider, auto-ban, credentials, or spoof the capability', async t => {
  const store = new Store(':memory:', { aiModerationEnabled: false });
  const secret = new Uint8Array(32).fill(1), key = getPublicKey(secret), origin = 'https://lnbits-nrm.test';
  const auth = new Auth(store, [key], origin), challenge = auth.challenge();
  const token = auth.login(challenge.token, finalizeEvent(challenge.event, secret));
  const app = await createApp({ store, relay: { busy: false }, admins: [key], origin, dist: '/does-not-exist' });
  t.after(async () => { await app.close(); store.close(); });
  const cookies = { aedos_session: token };
  for (const change of [
    { moderation: { ...store.settings().moderation, provider: 'openai' }, openaiKey: 'new-secret' },
    { moderation: { ...store.settings().moderation, provider: 'aedos', oracleUrl: 'https://example.com' } },
    { moderation: { ...store.settings().moderation, autoBan: true } },
    { oracleKey: 'new-secret' }, { openaiKey: 'new-secret' }
  ]) {
    const result = await app.inject({ method: 'PUT', url: '/api/settings', headers: { origin }, cookies, payload: { ...store.settings(), ...change } });
    assert.equal(result.statusCode, 403);
    assert.match(result.json().error, /disabled by the server operator/);
  }
  const spoofed = await app.inject({ method: 'PUT', url: '/api/settings', headers: { origin }, cookies, payload: { ...store.settings(), aiModerationEnabled: true } });
  assert.equal(spoofed.statusCode, 400);
  const result = await app.inject({ method: 'PUT', url: '/api/settings', headers: { origin }, cookies, payload: { ...store.settings(), retentionDays: 7 } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().aiModerationEnabled, false);
  assert.equal(result.json().retentionDays, 7);
  assert.equal(store.get('openaiKey'), undefined);
  assert.equal(store.get('oracleKey'), undefined);
});
