import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { Store } from '../server/store.js';
import { Auth } from '../server/auth.js';
import { createApp } from '../server/api.js';
import { Relay } from '../server/relay.js';

const secret = new Uint8Array(32).fill(1), key = getPublicKey(secret), origin = 'https://nrm.example.test';
async function fixture(t, relay = {}, dist = '/does-not-exist') {
  const store = new Store(':memory:');
  const auth = new Auth(store, [key], origin), c = auth.challenge();
  const token = auth.login(c.token, finalizeEvent(c.event, secret));
  const app = await createApp({ store, relay, admins: [key], origin, dist });
  t.after(async () => { await app.close(); store.close(); });
  return { store, app, auth, token, cookies: { aedos_session: token } };
}

test('shutdown rejects policy changes, deletion, bans and login before any side effects', async t => {
  const relay = { closing: true, maintenance: () => assert.fail('No maintenance may start'), applyPolicy: () => assert.fail('No policy may change') };
  const { store, app, cookies } = await fixture(t, relay);
  store.record({ id: 'a'.repeat(64), pubkey: key }, 'remove', 'test', ['offending']);
  const previous = store.settings();
  for (const [method, url, payload] of [
    ['PUT', '/api/settings', { ...previous, retentionDays: 1 }],
    ['POST', '/api/events/clear', { confirmation: 'CLEAR ALL NOTES' }],
    ['POST', '/api/retention/run', {}],
    ['POST', `/api/activity/${store.decisions()[0].seq}/ban`, {}],
    ['POST', '/api/auth/challenge', {}], ['POST', '/api/auth/logout', {}]
  ]) {
    const result = await app.inject({ method, url, headers: { origin }, cookies, payload });
    assert.equal(result.statusCode, 503, url);
    assert.match(result.json().error, /shutting down/);
  }
  assert.deepEqual(store.settings(), previous);
  assert.equal((await app.inject({ url: '/api/settings', cookies })).statusCode, 200, 'reads remain available during graceful shutdown');
  const managed = new Relay(store, { dataDir: '/unused' });
  managed.closing = true;
  assert.throws(() => managed.maintenance('clear'), /shutting down/);
  assert.equal(await managed.removeReviewed('a'.repeat(64)), false);
  assert.equal(store.get('maintenance'), undefined);
});

test('all write APIs reject cross-origin and originless requests even with a valid admin cookie', async t => {
  const { store, app, cookies } = await fixture(t);
  const previous = store.settings();
  for (const headers of [{}, { origin: 'null' }, { origin: 'https://attacker.test' }, { origin: origin + '.attacker.test' }]) {
    for (const [method, url, payload] of [
      ['PUT', '/api/settings', previous], ['POST', '/api/events/clear', { confirmation: 'CLEAR ALL NOTES' }],
      ['POST', '/api/retention/run', {}], ['POST', '/api/activity/1/ban', {}], ['POST', '/api/auth/logout', {}]
    ]) assert.equal((await app.inject({ method, url, headers, cookies, payload })).statusCode, 403, url);
  }
  assert.deepEqual(store.settings(), previous);
});

test('JSON prototype poisoning, forged forwarding headers and expired sessions cannot bypass protections', async t => {
  const { store, app, token, cookies } = await fixture(t);
  for (const body of ['{"__proto__":{"admin":true}}', '{"constructor":{"prototype":{"admin":true}}}']) {
    const result = await app.inject({ method: 'PUT', url: '/api/settings', headers: { origin, 'content-type': 'application/json' }, cookies, payload: body });
    assert.equal(result.statusCode, 400);
    assert.equal({}.admin, undefined);
  }
  for (let i = 0; i < 60; i++) {
    assert.equal((await app.inject({ url: '/api/auth/session', headers: { 'x-forwarded-for': `198.51.100.${i}` } })).statusCode, 200);
  }
  assert.equal((await app.inject({ url: '/api/auth/session', headers: { 'x-forwarded-for': '203.0.113.1' } })).statusCode, 429);
  store.db.prepare('UPDATE sessions SET expires=0').run();
  assert.equal((await app.inject({ url: '/api/settings', cookies: { aedos_session: token } })).statusCode, 401);
});

test('static files cannot disclose files outside dist; headers restrict scripts and framing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nrm-static-security-')), dist = join(dir, 'dist');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(dist); await writeFile(join(dist, 'index.html'), '<!doctype html><title>Fixture</title>');
  const marker = 'PRIVATE_FIXTURE_VALUE';
  await writeFile(join(dir, '.env'), marker); await writeFile(join(dir, 'lnbits-nrm.sqlite'), marker);
  const { app } = await fixture(t, {}, dist);
  const page = await app.inject('/');
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['x-frame-options'], 'DENY');
  for (const url of ['/.env', '/../.env', '/%2e%2e/.env', '/%2e%2e%2f.env', '/lnbits-nrm.sqlite', '/data/policy.json', '/server/main.js']) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 404, url);
    assert.ok(!response.body.includes(marker), url);
  }
  assert.equal((await app.inject('/api/auth/session')).headers['cache-control'], 'no-store');
});

test('slow incomplete management uploads are disconnected without creating a session', { timeout: 22000 }, async t => {
  const { app, store } = await fixture(t);
  await app.listen({ host: '127.0.0.1', port: 0 });
  assert.ok(app.server.requestTimeout > 0 && app.server.requestTimeout <= 30000);
  assert.ok(app.server.headersTimeout <= 15000);
  const socket = createConnection({ host: '127.0.0.1', port: app.server.address().port });
  t.after(() => socket.destroy());
  socket.on('error', () => {});
  await once(socket, 'connect');
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.write(`POST /api/auth/login HTTP/1.1\r\nHost: nrm.example.test\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  socket.resume();
  const before = store.db.prepare('SELECT count(*) AS n FROM sessions').get().n;
  await closed;
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM sessions').get().n, before);
  assert.equal((await app.inject('/api/auth/session')).statusCode, 200);
});
