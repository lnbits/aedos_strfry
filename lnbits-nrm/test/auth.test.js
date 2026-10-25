import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { Store } from '../server/store.js';
import { Auth } from '../server/auth.js';
import { createApp } from '../server/api.js';

const secret = new Uint8Array(32).fill(1), other = new Uint8Array(32).fill(2);
const key = getPublicKey(secret), origin = 'https://lnbits-nrm.test';
function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  return { store, auth: new Auth(store, [key], origin) };
}
test('admin signs a one-use challenge; sessions are revocable', t => {
  const { auth } = fixture(t);
  const c = auth.challenge(), signed = finalizeEvent(c.event, secret);
  const session = auth.login(c.token, signed);
  assert.equal(auth.session(session).pubkey, key);
  assert.throws(() => auth.login(c.token, signed), /Sign-in failed/);
  auth.logout(session);
  assert.equal(auth.session(session).authenticated, false);
});
test('unknown keys, tampering, stale events and incorrect origins are rejected', t => {
  const { auth } = fixture(t);
  let c = auth.challenge();
  assert.throws(() => auth.login(c.token, finalizeEvent(c.event, other)));
  c = auth.challenge();
  const tampered = JSON.parse(JSON.stringify(finalizeEvent(c.event, secret)));
  tampered.content = 'tampered';
  assert.throws(() => auth.login(c.token, tampered));
  c = auth.challenge();
  assert.throws(() => auth.login(c.token, finalizeEvent({ ...c.event, created_at: 1 }, secret)));
  c = auth.challenge(); c.event.tags[0][1] = 'https://evil.test/api/auth/login';
  assert.throws(() => auth.login(c.token, finalizeEvent(c.event, secret)));
});
test('API enforces authentication, origin, confirmation, validation and secret masking', async t => {
  const store = new Store(':memory:');
  const relay = { online: async () => true, overview: async () => ({ online: true }), maintenance: type => ({ type, status: 'running' }), busy: false };
  const app = await createApp({ store, relay, admins: [key], origin, dist: '/does-not-exist' });
  t.after(async () => { await app.close(); store.close(); });
  assert.equal((await app.inject('/api/settings')).statusCode, 401);
  for (const path of ['/api/settings?redirect=/api/auth/session', '/api/auth/../settings', '/api/auth/%2e%2e/settings', '/%61pi/settings']) {
    assert.ok([401, 404].includes((await app.inject(path)).statusCode), `Unauthorized path: ${path}`);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/challenge', headers: { origin: 'https://evil.test' } })).statusCode, 403);
  const challenge = await app.inject({ method: 'POST', url: '/api/auth/challenge', headers: { origin } });
  const challengeCookie = challenge.cookies.find(c => c.name === 'aedos_challenge').value;
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, cookies: { aedos_challenge: challengeCookie }, payload: { event: finalizeEvent(challenge.json().event, secret) } });
  assert.equal(login.statusCode, 200);
  assert.match(login.headers['set-cookie'].join(' '), /HttpOnly/);
  assert.match(login.headers['set-cookie'].join(' '), /Secure/);
  const cookies = { aedos_session: login.cookies.find(c => c.name === 'aedos_session').value };
  const settings = store.settings();
  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings', cookies, headers: { origin }, payload: { ...settings, rate: { perMinute: -1, perHour: 0 } } })).statusCode, 400);
  const saved = await app.inject({ method: 'PUT', url: '/api/settings', cookies, headers: { origin }, payload: { ...settings, openaiKey: 'test-secret' } });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().openaiKeySet, true);
  assert.equal(saved.body.includes('test-secret'), false);
  assert.equal((await app.inject({ method: 'POST', url: '/api/events/clear', cookies, headers: { origin }, payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/events/clear', cookies, headers: { origin }, payload: { confirmation: 'CLEAR ALL NOTES' } })).statusCode, 202);
  const event = { id: 'e'.repeat(64), pubkey: getPublicKey(other) };
  store.record(event, 'remove', 'Removed after review: block', ['offending']);
  const seq = store.decisions()[0].seq;
  const banUrl = '/api/activity/' + seq + '/ban';
  assert.equal((await app.inject({ method: 'POST', url: banUrl, headers: { origin } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: banUrl, cookies, headers: { origin: 'https://evil.test' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: banUrl, cookies, headers: { origin } })).statusCode, 200);
  assert.deepEqual(store.settings().block, [event.pubkey]);
  store.record(event, 'remove', 'Review unavailable', ['review-unavailable']);
  assert.equal((await app.inject({ method: 'POST', url: '/api/activity/' + store.decisions()[0].seq + '/ban', cookies, headers: { origin } })).statusCode, 400);
  relay.busy = true;
  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings', cookies, headers: { origin }, payload: store.settings() })).statusCode, 409);
});
test('unconfigured installations cannot be claimed by the first visitor', async t => {
  const store = new Store(':memory:');
  const app = await createApp({ store, relay: {}, admins: [], origin, dist: '/does-not-exist' });
  t.after(async () => { await app.close(); store.close(); });
  assert.equal((await app.inject('/api/auth/session')).json().configured, false);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/challenge', headers: { origin } })).statusCode, 503);
});
