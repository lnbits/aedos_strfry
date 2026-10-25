// Isolated deployment-capability test. Uses only a disposable volume, test keys,
// localhost ports, and a local mock oracle. Never touches an operator's relay.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { finalizeEvent, getPublicKey } from 'nostr-tools';

const exec = promisify(execFile);
const docker = async (...args) => (await exec('docker', args, { maxBuffer: 1024 * 1024 })).stdout.trim();
const pause = ms => new Promise(done => setTimeout(done, ms));
const freePort = () => new Promise(done => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => done(port)); }); });
const name = `lnbits-nrm-ai-disabled-${process.pid}`, volume = `${name}-data`, seedName = `${name}-seed`;
const uiPort = await freePort(), relayPort = await freePort();
const origin = `http://127.0.0.1:${uiPort}`, relayUrl = `ws://127.0.0.1:${relayPort}`;
const secret = new Uint8Array(32).fill(1), author = getPublicKey(secret);
let sequence = 0, cookies = new Map();
const note = (content = '#csam https://example.com/video.mp4') => finalizeEvent({ kind: 1, content: `${content} ${++sequence}`, tags: [], created_at: Math.floor(Date.now() / 1000) }, secret);
async function request(path, method = 'GET', body, expected = 200) {
  const response = await fetch(`${origin}/api${path}`, { method, headers: { origin, 'content-type': 'application/json', cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; ') }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const value of response.headers.getSetCookie()) { const [k,v] = value.split(';')[0].split('='); cookies.set(k,v); }
  const data = await response.json();
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`);
  return data;
}
async function waitFor(check, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) { try { if (await check()) return; } catch {} await pause(200); }
  throw new Error(`Timed out: ${label}`);
}
async function publish(event) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const timeout = setTimeout(() => { ws.close(); reject(Error('Publish timeout')); }, 10000);
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]));
    ws.onerror = error => { clearTimeout(timeout); reject(error); };
    ws.onmessage = ({ data }) => { const message = JSON.parse(data); if (message[0] === 'OK' && message[1] === event.id) { clearTimeout(timeout); ws.close(); resolve(message); } };
  });
}
const writable = ({ aiModerationEnabled, openaiKeySet, oracleKeySet, ...settings }) => settings;

try {
  await docker('volume', 'create', volume);
  const oldEvent = note('previously queued');
  await docker('run', '--rm', '--name', seedName, '-v', `${volume}:/data`, '--entrypoint', 'node', 'lnbits-nrm:local', '--input-type=module', '-e', `
    import {Store} from '/app/server/store.js';
    // Seed the legacy filename to exercise upgrades without losing saved settings.
    const store = new Store('/data/aedos.sqlite');
    store.saveSettings({...store.settings(), retentionDays:0, rate:{perMinute:0,perHour:0}, moderation:{...store.settings().moderation,provider:'aedos',oracleUrl:'http://127.0.0.1:8787',autoBan:true},oracleKey:'test-only-old-key'});
    store.enqueueReview(${JSON.stringify(oldEvent)},0);
    store.saveReviewResult(store.nextReview(2000).seq,{status:'block',reason:'block',labels:[]},store.settings().revision);
    store.close();
  `);
  await docker('run', '-d', '--name', name, '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '-v', `${volume}:/data`, '-p', `127.0.0.1:${uiPort}:3000`, '-p', `127.0.0.1:${relayPort}:7777`,
    '-e', 'AI_MODERATION_ENABLED=false', '-e', `ADMIN_NPUBS=${author}`, '-e', `PUBLIC_ORIGIN=${origin}`, '-e', `RELAY_URL=${relayUrl}`, 'lnbits-nrm:local');
  await waitFor(async () => (await fetch(`${origin}/api/health`)).ok, 'relay health');
  const challenge = await request('/auth/challenge', 'POST', {});
  await request('/auth/login', 'POST', { event: finalizeEvent(challenge.event, secret) });
  let settings = await request('/settings');
  assert.equal(settings.aiModerationEnabled, false);
  assert.equal(settings.oracleKeySet, true, 'saved key survives the application rename');
  assert.equal(settings.retentionDays, 0, 'saved retention is read from the legacy database');
  assert.deepEqual(settings.rate, { perMinute: 0, perHour: 0 });
  assert.equal(settings.moderation.provider, 'off');
  assert.equal(settings.moderation.autoBan, false);
  assert.deepEqual(settings.block, []);
  assert.equal((await request('/overview')).moderationQueue, 0);
  for (const provider of ['openai', 'aedos']) {
    const result = await request('/settings', 'PUT', { ...writable(settings), moderation: { ...settings.moderation, provider }, openaiKey: 'not-a-real-key' }, 403);
    assert.match(result.error, /disabled by the server operator/);
  }
  await request('/settings', 'PUT', { ...writable(settings), aiModerationEnabled: true }, 400);
  console.log('PASS Docker flag overrides saved providers, cancels old verdicts, and blocks API activation');

  await docker('exec', '-d', name, 'node', '--input-type=module', '-e', `
    import http from 'node:http'; let checks=0;
    http.createServer((req,res)=>{if(req.url==='/v1/check') checks++;res.end(JSON.stringify({checks,status:'block',labels:[]}));}).listen(8787,'127.0.0.1');
  `);
  const providerChecks = async () => JSON.parse(await docker('exec', name, 'node', '-e', "fetch('http://127.0.0.1:8787/status').then(r=>r.text()).then(console.log)")).checks;
  await waitFor(async () => await providerChecks() === 0, 'mock oracle');
  const accepted = note();
  assert.equal((await publish(accepted))[2], true);
  await pause(2000);
  assert.equal(await providerChecks(), 0);
  assert.equal((await request('/overview')).moderationQueue, 0);
  assert.ok((await request('/activity')).items.every(row => !row.labels.includes('review-pending') && row.action !== 'remove'));
  const exists = async () => Number(await docker('exec', name, 'strfry', '--config', '/data/strfry.conf', 'scan', '--count', JSON.stringify({ ids: [accepted.id] }))) === 1;
  assert.equal(await exists(), true);
  await docker('restart', name);
  await waitFor(async () => (await fetch(`${origin}/api/health`)).ok, 'health after restart');
  assert.equal((await request('/settings')).aiModerationEnabled, false);
  assert.equal(await exists(), true);
  settings = await request('/settings');
  await request('/settings', 'PUT', { ...writable(settings), wordFilter: { allow: [], block: ['forbidden'] } });
  await pause(1500); // Upstream configuration reload enables the previously bypassed plugin.
  assert.equal((await publish(note('forbidden')))[2], false);
  assert.equal((await publish(note('ordinary note')))[2], true);
  console.log('PASS relay publishes without AI calls or queueing, survives restart, and retains local word filtering');

  if (process.env.SKIP_BROWSER !== '1') {
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
      page.setDefaultTimeout(10000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.exposeFunction('testSignEvent', event => finalizeEvent(event, secret));
      await page.addInitScript(() => { window.nostr = { signEvent: event => window.testSignEvent(event) }; });
      await page.goto(origin);
      await page.getByRole('button', { name: 'Connect Nostr extension' }).click();
      await page.getByRole('heading', { name: 'Operations', exact: true }).waitFor();
      await page.getByRole('button', { name: 'AI moderation', exact: true }).click();
      await page.getByText('AI moderation is disabled by the server operator', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Provider', { exact: true }).count(), 0);
      assert.equal(await page.getByLabel('Automatically ban offending authors', { exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Save policy', exact: true }).count(), 0);
      await mkdir('test-results', { recursive: true });
      await page.screenshot({ path: 'test-results/ai-disabled.png', fullPage: true });
      await page.getByRole('button', { name: 'Rate limits', exact: true }).click();
      await page.getByLabel('Events per minute', { exact: true }).fill('120');
      await page.getByRole('button', { name: 'Save policy', exact: true }).click();
      await page.getByText('Policy saved. Allow a few seconds for strfry to apply a change between filtering and unrestricted publishing.').waitFor();
      settings = await request('/settings');
      assert.equal(settings.rate.perMinute, 120);
      assert.equal(settings.aiModerationEnabled, false);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
    console.log('PASS browser shows AI unavailable, offers no activation controls, and saves other relay settings');
  }
  console.log('All AI-disabled deployment checks passed.');
} catch (error) {
  console.error(await docker('logs', '--tail', '40', name).catch(() => 'No container logs'));
  throw error;
} finally {
  await docker('rm', '-f', '-v', name).catch(() => {});
  await docker('rm', '-f', '-v', seedName).catch(() => {});
  await docker('volume', 'rm', volume).catch(() => {});
}
