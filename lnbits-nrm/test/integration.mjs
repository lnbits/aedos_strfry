// Launches only a disposable, localhost-bound container with test keys and its own
// anonymous volume. Never points at an existing relay or deletes operator data.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';

const exec = promisify(execFile);
const docker = async (...args) => (await exec('docker', args, { maxBuffer: 1024 * 1024 })).stdout.trim();
const pause = ms => new Promise(done => setTimeout(done, ms));
const secretA = new Uint8Array(32).fill(1), secretB = new Uint8Array(32).fill(2), secretC = new Uint8Array(32).fill(3);
const a = getPublicKey(secretA), b = getPublicKey(secretB);
const name = `lnbits-nrm-integration-${process.pid}`;
const freePort = () => new Promise(done => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => done(port)); }); });
const uiPort = await freePort(), relayPort = await freePort();
const origin = `http://127.0.0.1:${uiPort}`, relayUrl = `ws://127.0.0.1:${relayPort}`;
let cookies = new Map();
async function request(path, method = 'GET', body) {
  const response = await fetch(`${origin}/api${path}`, {
    method, headers: { origin, 'content-type': 'application/json', cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  for (const value of response.headers.getSetCookie()) { const [key, token] = value.split(';')[0].split('='); cookies.set(key, token); }
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
async function waitFor(check, description, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { try { if (await check()) return; } catch {} await pause(200); }
  throw new Error(`Timed out: ${description}`);
}
async function healthy() { await waitFor(async () => (await fetch(`${origin}/api/health`)).ok, 'relay health'); }
async function save(change) {
  const current = await request('/settings');
  const { openaiKeySet, oracleKeySet, aiModerationEnabled, ...value } = current;
  const result = await request('/settings', 'PUT', { ...value, ...change });
  await pause(1500); // Upstream config hot reload when enabling/bypassing the plugin.
  return result;
}
let sequence = 0;
function note(secret, ageDays = 0, content = 'integration note', kind = 1) {
  return finalizeEvent({ kind, content: `${content} ${++sequence}`, tags: [], created_at: Math.floor(Date.now() / 1000) - ageDays * 86400 }, secret);
}
async function publish(event) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('Publish timeout')); }, 15000);
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]));
    ws.onerror = error => { clearTimeout(timeout); reject(error); };
    ws.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message[0] === 'OK' && message[1] === event.id) { clearTimeout(timeout); ws.close(); resolve(message); }
    };
  });
}
async function scan() {
  const output = await docker('exec', name, 'strfry', '--config', '/data/strfry.conf', 'scan', '{}');
  return output ? output.split('\n').map(line => JSON.parse(line)) : [];
}
async function maintenance(path, payload = {}) {
  await request(path, 'POST', payload);
  await waitFor(async () => {
    const job = (await request('/overview')).maintenance;
    if (job?.status === 'error') throw new Error(job.error);
    return job?.status === 'complete';
  }, path);
}

try {
  await docker('run', '-d', '--name', name, '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '-p', `127.0.0.1:${uiPort}:3000`, '-p', `127.0.0.1:${relayPort}:7777`,
    '-e', `ADMIN_NPUBS=${a}`, '-e', `PUBLIC_ORIGIN=${origin}`, '-e', `RELAY_URL=${relayUrl}`, 'lnbits-nrm:local');
  await healthy();
  await docker('exec', name, 'node', '-e', "const fs=require('node:fs'); if(!fs.existsSync('/data/lnbits-nrm.sqlite') || fs.existsSync('/data/aedos.sqlite')) process.exit(1)");
  const relayInfo = await (await fetch(relayUrl.replace('ws:', 'http:'), { headers: { accept: 'application/nostr+json' } })).json();
  assert.equal(relayInfo.name, 'LNbits NRM');
  assert.ok(relayInfo.description.startsWith('LNbits Nostr Relay Manager\n\nRelay policy: '));
  assert.ok(relayInfo.description.includes('Default age-based retention: unlimited.'));
  assert.equal(relayInfo.pubkey, a, 'omitted relay identity defaults to the first admin');
  assert.equal((await fetch(`${origin}/api/settings`)).status, 401);
  const challenge = await request('/auth/challenge', 'POST', {});
  const session = await request('/auth/login', 'POST', { event: finalizeEvent(challenge.event, secretA) });
  assert.equal(session.pubkey, a);
  console.log('PASS real signed-challenge sign-in and API protection');
  const disk = (await request('/overview')).disk;
  const diskCapacity = Number(await docker('exec', name, 'node', '--input-type=module', '-e', "import {statfs} from 'node:fs/promises'; const s=await statfs('/data/strfry-db',{bigint:true}); console.log(Number(s.bsize*s.blocks));"));
  assert.equal(disk.totalBytes, diskCapacity);
  assert.ok(disk.availableBytes >= 0 && disk.availableBytes <= disk.totalBytes);
  assert.equal(disk.usedBytes + disk.availableBytes + disk.reservedBytes, disk.totalBytes);
  console.log('PASS available storage reflects the real database filesystem');

  assert.equal((await request('/settings')).retentionDays, 0, 'fresh relay keeps notes forever');
  assert.deepEqual((await request('/settings')).retentionOverrides, []);
  await save({ rate: { perMinute: 0, perHour: 0 } });
  const oldA = note(secretA, 60), oldB = note(secretB, 60);
  assert.equal((await publish(oldA))[2], true);
  assert.equal((await publish(oldB))[2], true);
  await maintenance('/retention/run');
  const preserved = await scan();
  assert.ok(preserved.some(event => event.id === oldA.id));
  assert.ok(preserved.some(event => event.id === oldB.id));
  console.log('PASS fresh default and retention cleanup preserve old notes without configuration');
  assert.equal((await publish(note(secretA)))[2], true);
  await save({ allow: [a], block: [a, b] });
  assert.equal((await publish(note(secretA)))[2], true, 'allow list wins over block');
  assert.equal((await publish(note(secretB)))[2], false, 'blocked author');
  assert.equal((await publish(note(secretC)))[2], false, 'non-allowlisted author');
  await save({ allow: [], block: [b] });
  assert.equal((await publish(note(secretA)))[2], true);
  assert.equal((await publish(note(secretB)))[2], false);
  await save({ block: [] });
  assert.equal((await publish(note(secretB)))[2], true);
  console.log('PASS real WebSocket publishing and access-list precedence');
  await waitFor(async () => (await request('/traffic?range=1h')).totals.reject === 3, 'background policy traffic');
  const initialTraffic = await request('/traffic?range=1h');
  assert.equal(initialTraffic.totals.accept, 2);
  assert.equal(initialTraffic.totals.reject, 3);
  assert.ok(initialTraffic.totals.bytes > 0);
  assert.equal((await fetch(origin + '/api/traffic')).status, 401);
  console.log('PASS traffic records real relay publishing decisions without AI');

  await save({ wordFilter: { block: ['scam'], allow: ['scam prevention'] } });
  assert.equal((await publish(note(secretA, 0, 'SCAM')))[2], false, 'plain word rejected with AI off');
  assert.equal((await publish(note(secretA, 0, 'scamper')))[2], true, 'whole-word boundary');
  assert.equal((await publish(note(secretA, 0, 'Scam\n prevention tips')))[2], true, 'allowed phrase exception');
  assert.equal((await publish(note(secretA, 0, 'scam prevention then another scam')))[2], false, 'unrelated occurrence still blocked');
  await waitFor(async () => (await request('/activity')).items.some(item => item.labels.includes('word-filter')), 'background word-filter Activity');
  console.log('PASS real word/phrase filtering, exceptions and audit decisions with AI disabled');

  await save({ rate: { perMinute: 1, perHour: 1 } });
  assert.equal((await publish(note(secretC)))[2], true);
  assert.match((await publish(note(secretC)))[3], /rate-limited/);
  await pause(500);
  const beforeRestartTraffic = (await request('/traffic')).totals;
  await docker('restart', name);
  await healthy();
  assert.deepEqual((await request('/traffic')).totals, beforeRestartTraffic, 'traffic survives graceful restart');
  assert.equal((await publish(note(secretC)))[2], true, 'in-memory quota resets on restart');
  assert.match((await publish(note(secretC)))[3], /rate-limited/);
  assert.equal((await request('/auth/session')).authenticated, true, 'session survives restart');
  assert.deepEqual((await request('/settings')).wordFilter, { block: ['scam'], allow: ['scam prevention'] }, 'word rules survive restart');
  await save({ rate: { perMinute: 0, perHour: 0 } });
  console.log('PASS publishing quotas and persistent settings, sessions and counters');

  await save({ retentionDays: 30, retentionOverrides: [{ pubkey: a, days: 90 }] });
  await maintenance('/retention/run');
  let events = await scan();
  assert.ok(events.some(event => event.id === oldA.id), 'longer author override preserved');
  assert.ok(!events.some(event => event.id === oldB.id), 'expired default author deleted');
  assert.equal((await publish(note(secretB, 60)))[2], false, 'expired incoming event rejected');
  console.log('PASS actual LMDB retention deletion and author override preservation');

  const s = await request('/settings');
  async function reviewed(event, action) {
    await waitFor(async () => (await request('/activity')).items.some(row => row.event_id === event.id && row.action === action), 'background verdict');
  }
  async function present(event) { return (await scan()).some(row => row.id === event.id); }
  await save({ moderation: { ...s.moderation, provider: 'openai', timeoutSeconds: 2 }, openaiKey: 'not-a-real-key' });
  const tagged = note(secretA, 0, '#csam');
  assert.equal((await publish(tagged))[2], true, 'tags are moderated after acceptance');
  await reviewed(tagged, 'remove');
  assert.equal(await present(tagged), false);
  await save({ moderation: { ...s.moderation, provider: 'aedos', oracleUrl: 'http://127.0.0.1:65534', timeoutSeconds: 2, failurePolicy: 'reject', autoBan: true } });
  const failed = note(secretA);
  assert.equal((await publish(failed))[2], true);
  await reviewed(failed, 'remove');
  assert.equal(await present(failed), false);
  assert.deepEqual((await request('/settings')).block, [], 'provider outage never bans');
  await save({ moderation: { ...s.moderation, provider: 'aedos', oracleUrl: 'http://127.0.0.1:65534', timeoutSeconds: 2, failurePolicy: 'accept' } });
  const kept = note(secretA);
  assert.equal((await publish(kept))[2], true);
  await reviewed(kept, 'review');
  assert.equal(await present(kept), true);

  await docker('exec', '-d', name, 'node', '--input-type=module', '-e', `
    import http from 'node:http';
    let held = [], started = [];
    http.createServer(async (req,res) => {
      if (req.url === '/status') { res.end(JSON.stringify(started)); return; }
      if (req.url === '/release') { for (const send of held) send(); held = []; res.end('{}'); return; }
      let body=''; for await (const part of req) body+=part;
      const data=JSON.parse(body);
      if (!data.wait || !data.raw_event.sig) { res.writeHead(400).end(); return; }
      const text=data.raw_event.content;
      started.push(data.raw_event.id);
      const status=text.includes('review-block')?'block':text.includes('review-warn')?'warn':'safe';
      const send = () => { res.setHeader('content-type','application/json'); res.end(JSON.stringify({status,labels:[status]})); };
      if (text.includes('hold-review')) held.push(send); else send();
    }).listen(8787,'127.0.0.1');
  `);
  const control = async path => JSON.parse(await docker('exec', name, 'node', '-e',
    "fetch('http://127.0.0.1:8787" + path + "').then(r=>r.text()).then(console.log)"));
  await waitFor(async () => Array.isArray(await control('/status')), 'mock oracle ready');
  await save({ moderation: { ...s.moderation, provider: 'aedos', oracleUrl: 'http://127.0.0.1:8787', timeoutSeconds: 10 } });
  const held = note(secretA, 0, 'hold-review review-block');
  assert.equal((await publish(held))[2], true);
  await waitFor(async () => (await control('/status')).includes(held.id), 'held review starts');
  const next = note(secretA, 0, 'review-safe');
  assert.equal((await publish(next))[2], true, 'publishing continues while review is held');
  assert.equal(await present(held), true, 'note visible before verdict');
  assert.equal(await present(next), true);
  await control('/release');
  await reviewed(held, 'remove'); await reviewed(next, 'review');
  assert.equal(await present(held), false);
  assert.equal(await present(next), true);
  const decision = (await request('/activity')).items.find(row => row.event_id === held.id && row.action === 'remove');
  await request('/activity/' + decision.seq + '/ban', 'POST', {});
  assert.ok((await request('/settings')).block.includes(a));
  assert.equal((await publish(note(secretA)))[2], false, 'manual ban rejects future writes');
  await save({ block: [], moderation: { ...s.moderation, provider: 'aedos', oracleUrl: 'http://127.0.0.1:8787', timeoutSeconds: 10, autoBan: true } });
  const offender = note(secretB, 0, 'review-block');
  assert.equal((await publish(offender))[2], true);
  await reviewed(offender, 'remove');
  assert.ok((await request('/settings')).block.includes(b));
  assert.equal((await publish(note(secretB)))[2], false, 'automatic ban rejects future writes');
  const warning = note(secretA, 0, 'review-warn');
  await save({ allow: [a] });
  assert.equal((await publish(warning))[2], true);
  await reviewed(warning, 'remove');
  assert.ok((await request('/settings')).block.includes(a));
  const permitted = note(secretA, 0, 'review-safe');
  assert.equal((await publish(permitted))[2], true, 'allow list still authoritative');
  await reviewed(permitted, 'review');
  await save({ allow: [], block: [] });

  const cancelled = note(secretB, 0, 'hold-review review-block');
  assert.equal((await publish(cancelled))[2], true);
  await waitFor(async () => (await control('/status')).includes(cancelled.id), 'review active before clear');
  await maintenance('/events/clear', { confirmation: 'CLEAR ALL NOTES' });
  await control('/release');
  await pause(500);
  assert.equal((await request('/overview')).moderationQueue, 0);
  assert.deepEqual((await request('/settings')).block, [], 'clear cancels in-flight auto-ban');
  assert.equal((await scan()).length, 0);

  const interrupted = note(secretA, 0, 'hold-review review-block');
  assert.equal((await publish(interrupted))[2], true);
  await waitFor(async () => (await control('/status')).includes(interrupted.id), 'review active before crash');
  await docker('kill', '--signal', 'KILL', name);
  await docker('start', name);
  await healthy();
  // The mock server stops with the container. The persistent job resumes and
  // follows the configured remove-on-unavailable policy without banning anyone.
  await reviewed(interrupted, 'remove');
  assert.equal(await present(interrupted), false);
  assert.deepEqual((await request('/settings')).block, []);
  await save({ moderation: { ...s.moderation, provider: 'off' }, openaiKey: '' });
  console.log('PASS accept-first AI, subsequent publishing during review, removal, manual/automatic bans, allow priority, clear cancellation and crash recovery');

  await docker('exec', name, 'ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=128x96:rate=1', '-t', '4', '-pix_fmt', 'yuv420p', '-threads', '1', '-y', '/tmp/lnbits-nrm-test.mp4');
  await docker('exec', name, 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {readFile,readdir} from 'node:fs/promises';
    import {Moderator} from '/app/server/moderation.js';
    import {defaults} from '/app/server/config.js';
    const moderator=new Moderator({get:()=> 'test-key'}, {
      download:async()=>({bytes:await readFile('/tmp/lnbits-nrm-test.mp4'),mime:'video/mp4'}),
      fetch:async(url,options)=>{
        const input=JSON.parse(options.body).input;
        assert.equal(input.length,4);
        for(const image of input.slice(1)) assert.ok(image.image_url.url.startsWith('data:image/jpeg;base64,'));
        return new Response(JSON.stringify({results:[{flagged:false,categories:{}}]}));
      }
    });
    const settings={...defaults,revision:1,moderation:{...defaults.moderation,provider:'openai',videoFrames:3}};
    const result=await moderator.review({id:'test',content:'https://example.com/video.mp4',tags:[]},settings);
    assert.equal(result.status,'safe');
    assert.equal((await readdir('/tmp')).filter(name=>name.startsWith('lnbits-nrm-media-')).length,0);
  `);
  await docker('exec', name, 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {Moderator} from '/app/server/moderation.js';
    import {defaults} from '/app/server/config.js';
    let calls=0;
    const moderator=new Moderator({get:()=> 'test-key'}, {
      download:async()=>({bytes:Buffer.from("ffconcat version 1.0\\nfile '/tmp/lnbits-nrm-test.mp4'\\n"),mime:'video/mp4'}),
      fetch:async()=>{calls++;throw new Error('playlist reached provider');}
    });
    const result=await moderator.review({id:'playlist',content:'https://example.com/video.mp4',tags:[]},
      {...defaults,revision:1,moderation:{...defaults.moderation,provider:'openai'}});
    assert.equal(result.status,'error');
    assert.equal(calls,0);
  `);
  console.log('PASS real ffmpeg video sampling, playlist rejection and temporary-media cleanup');

  if (process.env.SKIP_BROWSER !== '1') {
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    let page;
    try {
      page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
      page.setDefaultTimeout(10000);
      const failures = [];
      page.on('pageerror', error => failures.push(error.message));
      // Test extension bridge signs the actual challenge with a disposable key.
      await page.exposeFunction('testSignEvent', event => finalizeEvent(event, secretA));
      await page.addInitScript(() => { window.nostr = { signEvent: event => window.testSignEvent(event) }; });
      await page.goto(origin);
      await page.getByRole('button', { name: 'Connect Nostr extension' }).click();
      await page.getByRole('heading', { name: 'Operations', exact: true }).waitFor();
      await mkdir('test-results', { recursive: true });
      await page.getByRole('heading', { name: 'Disk space', exact: true }).waitFor();
      assert.ok(Number(await page.getByRole('progressbar', { name: 'Disk space used or reserved' }).getAttribute('max')) > 0);
      await page.screenshot({ path: 'test-results/overview-light.png', fullPage: true });
      await page.getByRole('button', { name: 'Dark', exact: true }).click();
      await page.screenshot({ path: 'test-results/overview-dark.png', fullPage: true });
      await page.getByRole('button', { name: 'Traffic', exact: true }).first().click();
      await page.getByRole('heading', { name: 'Publishing activity', exact: true }).waitFor();
      assert.equal(await page.getByRole('img').count(), 3);
      await page.getByRole('heading', { name: 'Relay messages', exact: true }).waitFor();
      for (const [range, maximum] of [['1h', '59'], ['7d', '167'], ['30d', '179'], ['24h', '95']]) {
        await page.getByLabel('Traffic time range').selectOption(range);
        await waitFor(async () => await page.getByLabel('Publishing activity interval', { exact: true }).getAttribute('max') === maximum, 'traffic range');
      }
      const slider = page.getByLabel('Publishing activity interval', { exact: true });
      await slider.focus();
      await slider.press('Home');
      assert.equal(await slider.inputValue(), '0');
      await slider.press('End');
      assert.equal(await slider.inputValue(), '95');
      await page.screenshot({ path: 'test-results/traffic-dark.png', fullPage: true });
      await page.getByRole('button', { name: 'Light', exact: true }).click();
      await page.screenshot({ path: 'test-results/traffic-light.png', fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'traffic fits mobile');
      await page.screenshot({ path: 'test-results/traffic-mobile.png', fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1050 });
      await page.getByRole('button', { name: 'Dark', exact: true }).click();
      console.log('PASS traffic charts, all time ranges, keyboard inspection, themes and mobile layout');
      await page.getByRole('button', { name: 'Access lists', exact: true }).click();
      await page.locator('#allow-input').fill(nip19.npubEncode(a));
      await page.getByRole('button', { name: 'Add to allow list' }).click();
      await page.getByRole('button', { name: 'Save policy', exact: true }).click();
      await page.getByText('Policy saved. Allow a few seconds for strfry to apply a change between filtering and unrestricted publishing.').waitFor();
      assert.deepEqual((await request('/settings')).allow, [a]);
      await page.getByRole('button', { name: 'Word filters', exact: true }).click();
      await page.getByLabel('Blocked words and phrases', { exact: true }).fill('forbidden phrase');
      await page.getByLabel('Allowed words and phrases', { exact: true }).fill('not a forbidden phrase');
      await page.getByRole('button', { name: 'Save policy', exact: true }).click();
      await page.getByText('Policy saved. Allow a few seconds for strfry to apply a change between filtering and unrestricted publishing.').waitFor();
      assert.equal((await publish(note(secretA, 0, 'a forbidden phrase')))[2], false);
      assert.equal((await publish(note(secretA, 0, 'not a forbidden phrase')))[2], true);
      await page.reload();
      await page.getByRole('button', { name: 'Word filters', exact: true }).click();
      assert.equal(await page.getByLabel('Blocked words and phrases', { exact: true }).inputValue(), 'forbidden phrase');
      assert.equal(await page.getByLabel('Allowed words and phrases', { exact: true }).inputValue(), 'not a forbidden phrase');
      await page.screenshot({ path: 'test-results/word-filters.png', fullPage: true });
      await page.getByLabel('Blocked words and phrases', { exact: true }).fill('');
      await page.getByLabel('Allowed words and phrases', { exact: true }).fill('');
      await page.getByRole('button', { name: 'Save policy', exact: true }).click();
      await page.getByText('Policy saved. Allow a few seconds for strfry to apply a change between filtering and unrestricted publishing.').waitFor();
      assert.equal((await publish(note(secretA, 0, 'a forbidden phrase')))[2], true, 'clearing lists disables filtering');
      console.log('PASS browser word-list editing, persisted values and live enforcement');
      await page.getByRole('button', { name: 'Retention', exact: true }).click();
      await page.getByRole('heading', { name: 'Author overrides', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Rate limits', exact: true }).click();
      await page.getByRole('heading', { name: 'Rate limits', exact: true }).waitFor();
      await page.getByLabel('Events per minute', { exact: true }).fill('120');
      await page.getByRole('button', { name: 'Save policy', exact: true }).click();
      await page.getByText('Policy saved. Allow a few seconds for strfry to apply a change between filtering and unrestricted publishing.').waitFor();
      assert.equal((await request('/settings')).rate.perMinute, 120);
      await page.getByRole('button', { name: 'AI moderation', exact: true }).click();
      await page.getByLabel('Provider', { exact: true }).selectOption('openai');
      await page.getByLabel('OpenAI API key', { exact: true }).fill('browser-test-secret');
      await page.getByLabel('Automatically ban offending authors', { exact: true }).selectOption({ label: 'On · also add authors to the block list' });
      await page.getByRole('button', { name: 'Save policy', exact: true }).click();
      await page.getByText('Policy saved. Allow a few seconds for strfry to apply a change between filtering and unrestricted publishing.').waitFor();
      assert.equal((await request('/settings')).openaiKeySet, true);
      assert.equal((await request('/settings')).moderation.autoBan, true);
      assert.equal(await page.getByLabel('OpenAI API key', { exact: true }).inputValue(), '');
      await page.getByLabel('Provider', { exact: true }).selectOption('off');
      await page.getByRole('button', { name: 'Save policy', exact: true }).click();
      await page.getByText('Policy saved. Allow a few seconds for strfry to apply a change between filtering and unrestricted publishing.').waitFor();
      await page.getByRole('button', { name: 'Activity', exact: true }).first().click();
      const offendingRow = page.locator('tr').filter({ has: page.locator('code[title="' + held.id + '"]') });
      await offendingRow.getByRole('button', { name: 'Ban author', exact: true }).click();
      await offendingRow.getByRole('button', { name: 'On block list', exact: true }).waitFor();
      assert.ok((await request('/settings')).block.includes(a));
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: 'Overview', exact: true }).first().click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile has no horizontal overflow');
      await page.screenshot({ path: 'test-results/overview-mobile.png', fullPage: true });
      await page.getByRole('button', { name: 'Storage', exact: true }).click();
      await page.getByRole('heading', { name: 'Disk space', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'disk space fits mobile');
      await page.screenshot({ path: 'test-results/storage-mobile.png', fullPage: true });
      await page.route('**/api/overview', async route => {
        const response = await route.fetch();
        await route.fulfill({ json: { ...await response.json(), disk: null } });
      });
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.getByText('Available disk space could not be read.', { exact: true }).waitFor();
      await page.unroute('**/api/overview');
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.getByRole('progressbar', { name: 'Disk space used or reserved' }).waitFor();
      await page.getByRole('button', { name: 'Clear all notes…', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: 'Delete all events', exact: true }).isDisabled(), true);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.deepEqual(failures, []);
      console.log('PASS browser sign-in, policy forms, key masking, themes, mobile layout and deletion confirmation');
    } catch (error) {
      await page?.screenshot({ path: 'test-results/browser-failure.png', fullPage: true }).catch(() => {});
      throw error;
    } finally { await browser.close(); }
  }

  await pause(500);
  const beforeClearTraffic = (await request('/traffic')).totals;
  await maintenance('/events/clear', { confirmation: 'CLEAR ALL NOTES' });
  await healthy();
  assert.deepEqual((await request('/traffic')).totals, beforeClearTraffic, 'traffic history survives clear-all');
  assert.equal((await scan()).length, 0);
  assert.ok((await request('/activity')).items.length > 0, 'decision history retained');
  await save({ allow: [], block: [], rate: { perMinute: 0, perHour: 0 } });
  assert.equal((await publish(note(secretA)))[2], true, 'relay resumes after clear');
  console.log('PASS clear-all empties the actual relay database and publishing resumes');
  console.log('All integration checks passed.');
} catch (error) {
  console.error('Failure overview:', await request('/overview').catch(() => null));
  console.error('Recent decisions:', (await request('/activity').catch(() => ({ items: [] }))).items.slice(0, 20));
  const log = await exec('docker', ['logs', '--tail', '70', name], { maxBuffer: 1024 * 1024 }).catch(() => null);
  console.error(log ? log.stdout + log.stderr : 'No container logs');
  throw error;
} finally {
  await docker('rm', '-f', '-v', name).catch(() => {});
}
