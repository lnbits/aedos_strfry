// Isolated NIP-11 hot-reload test. No existing relay data or external AI service.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
const exec = promisify(execFile);
const docker = async (...args) => (await exec('docker', args, { maxBuffer: 1024 * 1024 })).stdout.trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const name = `lnbits-nrm-info-${process.pid}`;
const secret = new Uint8Array(32).fill(8), admin = getPublicKey(secret), other = 'b'.repeat(64);
const base = 'My "relay" \\ description\nSecond line';
let ws;
async function waitFor(check) {
  for (let i = 0; i < 100; i++) { try { if (await check()) return; } catch {} await pause(200); }
  throw Error('Timed out waiting for relay metadata');
}
try {
  await docker('run', '-d', '--name', name, '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '-p', '127.0.0.1::3000', '-p', '127.0.0.1::7777', '-e', `ADMIN_NPUBS=${admin}`, '-e', `RELAY_DESCRIPTION=${base}`,
    process.env.NRM_TEST_IMAGE || 'lnbits-nrm:local');
  const port = async n => (await docker('port', name, n)).split(':').at(-1);
  const origin = `http://127.0.0.1:${await port('3000')}`, relay = `http://127.0.0.1:${await port('7777')}`;
  const cookies = new Map();
  async function api(path, body) {
    const response = await fetch(origin + '/api' + path, { method: body ? (path === '/settings' ? 'PUT' : 'POST') : 'GET',
      headers: { origin: 'http://localhost:3000', 'content-type': 'application/json', cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; ') },
      body: body ? JSON.stringify(body) : undefined });
    for (const cookie of response.headers.getSetCookie()) { const [key, value] = cookie.split(';')[0].split('='); cookies.set(key, value); }
    assert.ok(response.ok, `${path}: ${response.status}`); return response.json();
  }
  const info = async () => (await fetch(relay, { headers: { accept: 'application/nostr+json' } })).json();
  await waitFor(async () => (await fetch(origin + '/api/health')).ok);
  const original = await info();
  assert.ok(original.description.startsWith(base + '\n\nRelay policy: '));
  assert.match(original.description, /age-based retention: unlimited/);
  const challenge = await api('/auth/challenge', {});
  await api('/auth/login', { event: finalizeEvent(challenge.event, secret) });
  async function save(change) {
    const { aiModerationEnabled, openaiKeySet, oracleKeySet, ...settings } = await api('/settings');
    return api('/settings', { ...settings, ...change });
  }
  ws = new WebSocket(relay.replace('http:', 'ws:'));
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let closed = false; ws.onclose = () => { closed = true; };
  await save({ retentionDays: 30, retentionOverrides: [{ pubkey: other, days: 0 }], block: [other],
    wordFilter: { allow: ['private-allowed-phrase'], block: ['private-blocked-phrase'] }, rate: { perMinute: 10, perHour: 100 } });
  await waitFor(async () => (await info()).description.includes('30 days from event creation'));
  let text = (await info()).description;
  assert.match(text, /10 attempts per UTC minute and 100 attempts per UTC hour/);
  assert.match(text, /retention exceptions/); assert.match(text, /Word and phrase filtering is enabled/);
  for (const value of [other, 'private-allowed-phrase', 'private-blocked-phrase']) assert.equal(text.includes(value), false);
  await save({ retentionDays: 7 });
  await waitFor(async () => (await info()).description.includes('7 days from event creation'));
  assert.doesNotMatch((await info()).description, /30 days/);
  const settings = await api('/settings');
  await save({ moderation: { ...settings.moderation, provider: 'aedos', oracleUrl: 'http://127.0.0.1:1/private-oracle', autoBan: true } });
  await waitFor(async () => (await info()).description.includes('AI moderation reviews accepted events'));
  text = (await info()).description;
  assert.match(text, /Offending authors may also be added/); assert.equal(text.includes('private-oracle'), false);
  await save({ retentionDays: 0, retentionOverrides: [], allow: [], block: [], wordFilter: { allow: [], block: [] },
    rate: { perMinute: 0, perHour: 0 }, moderation: { ...settings.moderation, provider: 'off' } });
  await waitFor(async () => (await info()).description.includes('No per-author publishing rate limits.'));
  text = (await info()).description;
  assert.match(text, /AI moderation is disabled/); assert.doesNotMatch(text, /five minutes|retention exceptions/);
  assert.equal(text.split('Relay policy:').length, 2);
  assert.equal(closed, false, 'metadata edits preserve existing WebSocket connections');
  const event = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'after metadata updates' }, secret);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Publish timeout')), 5000);
    ws.onmessage = ({ data }) => { const response = JSON.parse(data); if (response[0] === 'OK' && response[1] === event.id) { clearTimeout(timer); response[2] ? resolve() : reject(Error(response[3])); } };
    ws.send(JSON.stringify(['EVENT', event]));
  });
  console.log('PASS live NIP-11 defaults, retention/rate edits, private rule redaction, AI summary, plugin bypass and existing WebSocket publishing');
} finally {
  ws?.close();
  await docker('rm', '-f', '-v', name).catch(() => {});
}
