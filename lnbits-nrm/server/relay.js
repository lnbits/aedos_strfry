import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdir, writeFile, rename, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expired } from './config.js';
import { diskSpace } from './storage.js';
import { needsPlugin } from './policy.js';
import { policyDescription } from './relay-info.js';

const exec = promisify(execFile);

export class Relay {
  constructor(store, options) {
    this.store = store;
    this.dataDir = options.dataDir;
    this.bin = options.bin || 'strfry';
    this.config = join(this.dataDir, 'strfry.conf');
    this.options = options;
    this.child = null;
    this.busy = false;
    this.stopping = false;
    this.closing = false;
    this.countError = null;
    this.probe = null;
    this.probedAt = 0;
    this.count = null;
    this.countAt = null;
    this.counting = null;
    this.error = null;
  }
  configText(settings) {
    const q = JSON.stringify;
    return `db = ${q(join(this.dataDir, 'strfry-db'))}
events {
  rejectEventsOlderThanSeconds = 3153600000
}
relay {
  bind = "0.0.0.0"
  port = 7777
  nofiles = 0
  auth {
    enabled = true
    serviceUrl = ${q(this.options.relayUrl)}
  }
  info {
    name = ${q(this.options.name)}
    description = ${q(policyDescription(this.options.description, settings))}
    pubkey = ${q(this.options.pubkey || '')}
    contact = ${q(this.options.contact || '')}
  }
  writePolicy {
    plugin = ${q(needsPlugin(settings) ? resolve('server/plugin.sh') : '')}
    timeoutSeconds = 5
  }
}
`;
  }
  async configure() {
    await mkdir(join(this.dataDir, 'strfry-db'), { recursive: true, mode: 0o700 });
    const settings = this.store.settings();
    await writeFile(join(this.dataDir, 'policy.json.next'), JSON.stringify(settings), { mode: 0o600 });
    await rename(join(this.dataDir, 'policy.json.next'), join(this.dataDir, 'policy.json'));
    this.pluginEnabled = needsPlugin(settings);
    this.appliedRevision = settings.revision;
    await writeFile(this.config, this.configText(settings), { mode: 0o600 });
    this.advertisedDescription = policyDescription(this.options.description, settings);
    this.policyError = null;
    const previous = this.store.get('maintenance');
    if (previous?.status === 'running') this.store.set('maintenance', { ...previous, status: 'error', error: 'Interrupted by service restart', finishedAt: Date.now() });
  }
  applyPolicy() {
    this.syncing = (this.syncing ?? Promise.resolve()).catch(() => {}).then(async () => {
      const settings = this.store.settings();
      if (settings.revision === this.appliedRevision) return;
      const next = join(this.dataDir, 'policy.json.next');
      await writeFile(next, JSON.stringify(settings), { mode: 0o600 });
      await rename(next, join(this.dataDir, 'policy.json'));
      const enabled = needsPlugin(settings);
      const description = policyDescription(this.options.description, settings);
      if (enabled !== this.pluginEnabled || description !== this.advertisedDescription) {
        // Metadata and plugin switches use upstream hot reload, never a relay restart.
        await writeFile(this.config + '.next', this.configText(settings), { mode: 0o600 });
        await rename(this.config + '.next', this.config);
        this.pluginEnabled = enabled;
        this.advertisedDescription = description;
      }
      this.appliedRevision = settings.revision;
      this.policyError = null;
    }).catch(error => { this.policyError = 'Saved policy could not be applied to strfry; last applied rules may remain active'; throw error; });
    return this.syncing;
  }
  start() {
    if (this.child || this.closing) return;
    this.probe = null;
    this.probedAt = 0;
    this.stopping = false;
    if (this.metrics) this.metrics.previous = { received: 0, sent: 0, events: 0 };
    const child = spawn(this.bin, ['--config', this.config, 'relay'], { stdio: ['ignore', 'inherit', 'inherit'] });
    this.child = child;
    child.once('error', () => { this.error = 'Could not start strfry'; this.options.onFatal?.(); });
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      if (!this.stopping) { this.error = `strfry exited (${code ?? signal})`; this.options.onFatal?.(); }
    });
  }
  async stop() {
    this.stopping = true;
    const child = this.child;
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
      child.kill('SIGTERM');
    });
  }
  async online() {
    if (!this.child || this.stopping) return false;
    if (this.probe && Date.now() - this.probedAt < 1000) return this.probe;
    this.probedAt = Date.now();
    this.probe = (async () => {
      try {
        const response = await fetch('http://127.0.0.1:7777/', { signal: AbortSignal.timeout(1500), headers: { accept: 'application/nostr+json' } });
        await response.body?.cancel();
        return response.ok;
      } catch { return false; }
    })();
    return this.probe;
  }
  command(args, onLine, timeoutMs = 300000) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, ['--config', this.config, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      let stderr = '', output = '', parseError;
      child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
      const processing = (async () => {
        const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
        for await (const line of lines) {
          if (onLine) await onLine(line);
          else { output += line + '\n'; if (output.length > 65536) throw new Error('Unexpected strfry output'); }
        }
      })().catch(error => { parseError = error; child.kill('SIGKILL'); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', async code => {
        clearTimeout(timer);
        await processing;
        if (parseError) reject(parseError);
        else if (code !== 0) reject(new Error(`strfry ${args[0]} failed (${code}): ${stderr.slice(-1000)}`));
        else resolve(output.trim());
      });
    });
  }
  async hasEvent(id) {
    return Number(await this.command(['scan', '--count', JSON.stringify({ ids: [id] })])) > 0;
  }
  async removeReviewed(id) {
    if (this.busy || this.closing) return false;
    this.busy = true;
    try {
      await this.command(['delete', '--filter', JSON.stringify({ ids: [id] })], undefined, 30000);
      this.countAt = null;
      return true;
    } finally { this.busy = false; }
  }
  refreshCount() {
    if (this.counting) return this.counting;
    // LMDB table metadata is constant-time; scanning all events overloads large relays.
    this.counting = exec('mdb_stat', ['-s', 'rasgueadb_defaultDb__Event', join(this.dataDir, 'strfry-db')], { timeout: 5000, maxBuffer: 65536 }).then(({ stdout }) => {
      const match = stdout.match(/^\s*Entries:\s*(\d+)\s*$/m);
      const count = match ? Number(match[1]) : NaN;
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid relay event count');
      this.count = count;
      this.countAt = Date.now();
      this.countError = null;
    }).catch(() => { this.countError = 'Could not count relay events'; }).finally(() => { this.counting = null; });
    return this.counting;
  }
  maintenance(type) {
    if (this.closing) throw Object.assign(new Error('Service is shutting down; retry after restart'), { statusCode: 503 });
    if (this.busy) throw Object.assign(new Error('A maintenance job is already running'), { statusCode: 409 });
    const job = { type, status: 'running', startedAt: Date.now(), deleted: 0, error: null };
    this.store.set('maintenance', job);
    this.busy = true;
    this.job = (async () => {
      try {
        if (type === 'clear') {
          await this.stop();
          this.reporting?.discard();
          this.store.clearReviews();
          try {
            await this.command(['delete', '--filter', '{}']);
            this.count = 0;
            this.countAt = Date.now();
          } finally { this.start(); }
        } else {
          const settings = this.store.settings();
          const finite = [settings.retentionDays, ...settings.retentionOverrides.map(r => r.days)].filter(n => n > 0);
          if (finite.length) {
            const now = Math.floor(Date.now() / 1000);
            let ids = [];
            const flush = async () => {
              if (!ids.length) return;
              await this.command(['delete', '--filter', JSON.stringify({ ids })]);
              job.deleted += ids.length;
              this.store.set('maintenance', job);
              ids = [];
            };
            // Filtering each scanned event preserves longer-lived and unlimited exceptions.
            await this.command(['scan', JSON.stringify({ until: now - Math.min(...finite) * 86400 })], async line => {
              const event = JSON.parse(line);
              if (expired(event, settings, now)) ids.push(event.id);
              if (ids.length >= 500) await flush();
            });
            await flush();
          }
        }
        job.status = 'complete';
      } catch (error) {
        job.status = 'error';
        job.error = error.message;
      } finally {
        job.finishedAt = Date.now();
        try { this.store.set('maintenance', job); }
        catch { this.error = 'Could not save maintenance status'; }
        finally { this.busy = false; }
        await this.refreshCount();
      }
    })();
    return job;
  }
  async overview() {
    if (!this.countAt || Date.now() - this.countAt > 60000) void this.refreshCount();
    const databaseDir = join(this.dataDir, 'strfry-db');
    const [file, disk, online] = await Promise.all([
      stat(join(databaseDir, 'data.mdb')).catch(() => null), diskSpace(databaseDir), this.online()
    ]);
    return {
      online, disk, relayUrl: this.options.relayUrl, name: this.options.name,
      eventCount: this.count, countedAt: this.countAt, databaseBytes: file?.size ?? 0,
      policyRevision: this.store.settings().revision, appliedRevision: this.appliedRevision, pluginEnabled: this.pluginEnabled,
      reportingError: this.reporting?.error ?? this.reporting?.warning ?? this.metrics?.error ?? null,
      moderationQueue: this.store.reviewCount(), moderationError: this.reviewWorker?.error ?? null,
      counters: this.store.get('counters') ?? { accept: 0, reject: 0 },
      maintenance: this.store.get('maintenance') ?? null, error: this.policyError ?? this.error ?? this.countError,
      uptimeSeconds: Math.floor(process.uptime())
    };
  }
}
