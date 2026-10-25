// Disposable containers only. Compares the same strfry binary with/without NRM,
// then injects policy failures and checks recovery against actual stored events.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
const exec = promisify(execFile);
const docker = async (...args) => (await exec('docker', args, { maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
const pause = ms => new Promise(r => setTimeout(r, ms));
const secret = new Uint8Array(32).fill(7), admin = getPublicKey(secret);
let sequence = 0;
const note = () => finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: `${++sequence} ${'x'.repeat(1024)}` }, secret);
const image = process.env.NRM_TEST_IMAGE || 'lnbits-nrm:local';
const count = Number(process.env.NRM_TEST_EVENTS || 1000);
const concurrency = Number(process.env.NRM_TEST_CONNECTIONS || 16);
const filtered = process.env.NRM_TEST_FILTER === '1';
const warmup = Number(process.env.NRM_TEST_WARMUP || 0);
assert.ok(Number.isInteger(warmup) && warmup >= 0 && warmup <= 2000);
assert.ok(Number.isInteger(count) && count > 0 && count <= 20000);
assert.ok(Number.isInteger(concurrency) && concurrency > 0 && concurrency <= 256);
const events = Array.from({ length: count + warmup }, note); // Sign before timing.
async function waitFor(check, label) {
  for (let i = 0; i < 150; i++) { try { if (await check()) return; } catch {} await pause(200); }
  throw new Error(`Timed out: ${label}`);
}
async function connection(url) {
  const ws = new WebSocket(url), pending = new Map();
  const opened = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => {
    const reply = JSON.parse(data);
    const request = reply[0] === 'OK' && pending.get(reply[1]);
    if (request) { clearTimeout(request.timer); pending.delete(reply[1]); request.resolve(reply); }
  };
  await opened;
  return {
    ws,
    publish(event) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(event.id); reject(new Error('Publish timeout')); }, 60000);
        pending.set(event.id, { resolve, timer });
        ws.send(JSON.stringify(['EVENT', event]));
      });
    }
  };
}
async function readEvent(url, id) {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    let found = false;
    const timer = setTimeout(() => { ws.close(); reject(new Error('Read timeout')); }, 10000);
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'audit', { ids: [id] }]));
    ws.onmessage = ({ data }) => {
      const reply = JSON.parse(data);
      if (reply[0] === 'EVENT') found = reply[2].id === id;
      if (reply[0] === 'EOSE') { clearTimeout(timer); ws.close(); resolve(found); }
    };
    ws.onerror = reject;
  });
}
const results = [];
for (const managed of (process.env.NRM_TEST_MANAGED_FIRST === '1' ? [true, false] : [false, true])) {
  const name = `lnbits-nrm-reliability-${process.pid}-${managed ? 'managed' : 'bare'}`;
  const sockets = [];
  try {
    const config = 'db = "/data/strfry-db"\nevents { rejectEventsOlderThanSeconds = 3153600000 }\nrelay { bind = "0.0.0.0" port = 7777 nofiles = 0 }\n';
    const args = ['run', '-d', '--name', name, '--cpus=1', '--memory=512m', '--memory-swap=512m', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
      '-p', '127.0.0.1::3000', '-p', '127.0.0.1::7777', '-e', `ADMIN_NPUBS=${admin}`, '-e', 'AI_MODERATION_ENABLED=false'];
    if (managed) args.push(image);
    else args.push('--entrypoint', 'sh', image, '-c',
      `mkdir -p /data/strfry-db && printf '%s' '${config}' > /data/strfry.conf && exec strfry --config /data/strfry.conf relay`);
    await docker(...args);
    const port = async p => (await docker('port', name, p)).split(':').at(-1);
    let origin, url;
    const refreshPorts = async () => { origin = `http://127.0.0.1:${await port("3000")}`; url = `ws://127.0.0.1:${await port("7777")}`; };
    await refreshPorts();
    const cookies = new Map();
    async function api(path, method = 'GET', body) {
      const response = await fetch(`${origin}/api${path}`, { method,
        headers: { origin: 'http://localhost:3000', 'content-type': 'application/json', cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
        body: body === undefined ? undefined : JSON.stringify(body) });
      for (const cookie of response.headers.getSetCookie()) { const [k, v] = cookie.split(';')[0].split('='); cookies.set(k, v); }
      assert.ok(response.ok, `${path} ${response.status}`);
      return response.json();
    }
    const healthy = () => waitFor(async () => (await fetch(managed ? `${origin}/api/health` : url.replace('ws:', 'http:'),
      { headers: { accept: 'application/nostr+json' } })).ok, 'health');
    await healthy();
    if (managed) {
      const challenge = await api('/auth/challenge', 'POST', {});
      await api('/auth/login', 'POST', { event: finalizeEvent(challenge.event, secret) });
      const { aiModerationEnabled, openaiKeySet, oracleKeySet, ...settings } = await api('/settings');
      assert.equal(settings.retentionDays, 0);
      await api('/settings', 'PUT', { ...settings, rate: { perMinute: 0, perHour: 0 }, wordFilter: { allow: [], block: filtered ? ['deniedword'] : [] } });
      await pause(1500);
    }
    for (let i = 0; i < concurrency; i++) sockets.push(await connection(url));
    let warming = 0;
    await Promise.all(sockets.map(async socket => {
      while (warming < warmup) assert.equal((await socket.publish(events[warming++]))[2], true);
    }));
    let next = warmup;
    const latency = [], start = performance.now();
    await Promise.all(sockets.map(async socket => {
      while (next < events.length) {
        const event = events[next++], before = performance.now();
        const reply = await socket.publish(event);
        assert.equal(reply[2], true, JSON.stringify(reply));
        latency.push(performance.now() - before);
      }
    }));
    const elapsed = performance.now() - start;
    console.log(`Completed ${managed ? "managed" : "bare"} load in ${(elapsed / 1000).toFixed(2)}s`);
    latency.sort((a, b) => a - b);
    results.push({ mode: managed ? (filtered ? 'NRM independent word filter, AI off, quotas off' : 'NRM plugin bypassed, native metrics only') : 'strfry without policy plugin', events: count, warmup, connections: sockets.length,
      seconds: +(elapsed / 1000).toFixed(2), eventsPerSecond: +(count * 1000 / elapsed).toFixed(1),
      p50ms: +latency[Math.floor(latency.length * .5)].toFixed(1), p95ms: +latency[Math.floor(latency.length * .95)].toFixed(1),
      memoryAfter: await docker('stats', '--no-stream', '--format', '{{.MemUsage}}', name) });
    const scan = async () => {
      const output = await docker('exec', name, 'strfry', '--config', '/data/strfry.conf', 'scan', '{}');
      return output ? output.split('\n').map(line => JSON.parse(line).id).sort() : [];
    };
    const expected = events.map(e => e.id).sort();
    await waitFor(async () => (await scan()).length === expected.length, 'all acknowledged events stored');
    assert.deepEqual(await scan(), expected);
    if (managed) {
      const sql = statement => docker('exec', name, 'node', '--input-type=module', '-e',
        `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync('/data/lnbits-nrm.sqlite'); db.exec(${JSON.stringify(statement)}); db.close();`);
      const { aiModerationEnabled, openaiKeySet, oracleKeySet, ...settings } = await api('/settings');
      await api('/settings', 'PUT', { ...settings, wordFilter: { allow: [], block: ['deniedword'] }, rate: { perMinute: 0, perHour: 0 } });
      await pause(1500);
      await sql("CREATE TRIGGER audit_fail BEFORE INSERT ON decisions BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END");
      const acceptedDuringFailure = note();
      assert.equal((await sockets[0].publish(acceptedDuringFailure))[2], true, 'Activity failure must not block the relay');
      expected.push(acceptedDuringFailure.id); expected.sort();
      await waitFor(async () => (await api('/overview')).reportingError?.includes('could not be saved'), 'reporting failure visibility');
      assert.equal((await fetch(`${origin}/api/health`)).status, 200, 'reporting failure is separate from relay availability');
      assert.equal(await readEvent(url, events[0].id), true);
      assert.equal(await readEvent(url, acceptedDuringFailure.id), true);
      const forbidden = finalizeEvent({ kind: 1, content: 'deniedword', tags: [], created_at: Math.floor(Date.now() / 1000) }, secret);
      assert.equal((await sockets[0].publish(forbidden))[2], false, 'word rules remain enforced during storage failure');
      await sql('DROP TRIGGER audit_fail');
      await waitFor(async () => !(await api('/overview')).reportingError?.includes('could not be saved'), 'reporting recovery');
      // Stop only the manager process in this disposable container. strfry and
      // its plugin must continue accepting/rejecting without its event loop.
      const managerPid = await docker('exec', name, 'node', '-e', "const fs=require('node:fs'); for(const p of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))){try{if(fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0')[1]==='server/main.js')console.log(p)}catch{}}");
      assert.match(managerPid, /^\d+$/);
      await docker('exec', name, 'node', '-e', "process.kill(Number(process.argv[1]), 'SIGSTOP')", managerPid);
      try {
        for (let i = 0; i < 50; i++) {
          const event = note(); assert.equal((await sockets[i % sockets.length].publish(event))[2], true); expected.push(event.id);
        }
        assert.equal((await sockets[0].publish(forbidden))[2], false, 'filtering works while the manager is stopped');
      } finally { await docker('exec', name, 'node', '-e', "process.kill(Number(process.argv[1]), 'SIGCONT')", managerPid); }
      expected.sort();
      const { aiModerationEnabled: ignoredAI, openaiKeySet: ignoredKey, oracleKeySet: ignoredOracle, ...current } = await api('/settings');
      await api('/settings', 'PUT', { ...current, rate: { perMinute: 3, perHour: 3 } });
      const limited = await Promise.all(sockets.map(async socket => {
        const event = note(); return { event, reply: await socket.publish(event) };
      }));
      assert.equal(limited.filter(row => row.reply[2]).length, Math.min(3, sockets.length), 'in-memory quota cannot overshoot');
      expected.push(...limited.filter(row => row.reply[2]).map(row => row.event.id)); expected.sort();
      // Missing rules reject; restoring the rules file recovers without NRM calls.
      await docker('exec', name, 'mv', '/data/policy.json', '/data/policy.saved');
      try { assert.equal((await sockets[0].publish(note()))[2], false); }
      finally { await docker('exec', name, 'mv', '/data/policy.saved', '/data/policy.json'); }
      await waitFor(async () => (await scan()).length === expected.length, 'exactly the accepted events stored');
      await waitFor(async () => (await api('/traffic')).nativeTotals.events > 0, 'native graphs collect with or without a plugin');
      for (const socket of sockets) socket.ws.close();
      await docker('restart', name);
      await refreshPorts();
      await healthy();
      assert.deepEqual(await scan(), expected, 'graceful restart preserves all stored events');
      await docker('kill', '--signal', 'KILL', name);
      await docker('start', name);
      await refreshPorts();
      await healthy();
      assert.deepEqual(await scan(), expected, 'abrupt container stop preserves committed events');
      assert.equal((await api('/auth/session')).authenticated, true, 'admin session survives');
      await api('/overview');
      await waitFor(async () => (await api('/overview')).eventCount === expected.length, 'LMDB metadata count');
      const integrity = await docker('exec', name, 'node', '--input-type=module', '-e',
        "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync('/data/lnbits-nrm.sqlite'); console.log(db.prepare('PRAGMA integrity_check').get().integrity_check); db.close();");
      assert.equal(integrity, 'ok');
      console.log('PASS concurrent publishing, in-memory quotas, missing-rule rejection, continued enforcement during Activity failure and manager suspension, reporting recovery, native metrics, restart, crash, metadata count and SQLite integrity');
    }
  } catch (error) {
    console.error(await docker('logs', '--tail', '30', name).catch(() => 'No logs'));
    throw error;
  } finally {
    for (const socket of sockets) socket.ws.close();
    await docker('rm', '-f', '-v', name).catch(() => {});
  }
}
console.log(JSON.stringify({ limits: 'Each container: 1 CPU, 512 MiB memory, no swap; disposable empty database, localhost, 1 KiB note text; memory is a post-load snapshot, not peak.', results }, null, 2));
