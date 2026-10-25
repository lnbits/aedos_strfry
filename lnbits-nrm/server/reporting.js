import { createServer } from 'node:net';

// Best-effort, bounded reporting. Nothing here can approve or reject a relay write.
export class Reporting {
  constructor(store) {
    this.store = store; this.pending = []; this.bytes = 0;
    this.error = null; this.warning = null; this.dropped = 0;
    this.sockets = new Set();
    this.server = createServer(socket => {
      if (this.sockets.size >= 4) { socket.destroy(); return; }
      this.sockets.add(socket);
      let buffer = Buffer.alloc(0);
      socket.on('error', () => {});
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        let end;
        while ((end = buffer.indexOf(10)) !== -1) {
          if (end > 128 * 1024) { socket.destroy(); return; }
          const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
          try { this.receive(JSON.parse(line.toString('utf8')), line.length); }
          catch { socket.destroy(); return; }
        }
        if (buffer.length > 128 * 1024) socket.destroy();
      });
    });
    this.server.on('error', () => { this.error = 'Reporting listener unavailable; relay publishing continues'; });
  }
  receive(row, bytes = Buffer.byteLength(JSON.stringify(row))) {
    if (!/^[a-f0-9]{64}$/.test(row.event?.id) || !/^[a-f0-9]{64}$/.test(row.event?.pubkey) ||
        !['accept', 'reject'].includes(row.action) || typeof row.reason !== 'string' || row.reason.length > 1000 ||
        !Array.isArray(row.labels) || row.labels.length > 10 || row.labels.some(v => typeof v !== 'string' || v.length > 100) ||
        !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > 128 * 1024 ||
        (row.review && (typeof row.event.content !== 'string' || !Array.isArray(row.event.tags)))) throw Error('Invalid report');
    if (row.dropped > 0) this.warning = 'Some Activity records or AI review candidates were lost while reporting was unavailable or overloaded';
    if (this.pending.length >= 10000 || this.bytes + bytes > 8 * 1024 * 1024) {
      this.dropped++; this.warning = 'Reporting buffer full: some Activity records and AI review candidates were dropped'; return;
    }
    this.pending.push(row); this.bytes += bytes;
  }
  start() {
    this.timer = setInterval(() => { try { this.flush(); } catch { /* retain bounded buffer for retry */ } }, 250);
    this.timer.unref();
  }
  flush() {
    if (!this.pending.length) return;
    const rows = this.pending.map(row => ({ ...row, labels: [...row.labels] }));
    let queueFull = false;
    try {
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        const settings = this.store.settings();
        for (const row of rows) {
          if (row.review && row.action === 'accept' && this.store.aiModerationEnabled && settings.moderation.provider !== 'off') {
            if (!this.store.enqueueReview(row.event)) {
              queueFull = true; row.labels.push('review-skipped'); row.reason = 'Accepted; AI review queue full';
            } else { row.labels.push('review-pending'); row.reason = 'Accepted; background review pending'; }
          }
        }
        this.store.recordMany(rows);
        this.store.db.exec('COMMIT');
      } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
      for (const row of rows) this.store.traffic.record(row.action, row.bytes);
      this.pending = []; this.bytes = 0; this.error = null;
      if (queueFull) this.warning = 'AI review queue full: some accepted notes were not queued for review';
    } catch (error) { this.error = 'Background reporting could not be saved; relay publishing continues'; throw error; }
  }
  discard() { this.pending = []; this.bytes = 0; }
  async close() {
    clearInterval(this.timer);
    for (const socket of this.sockets) socket.destroy();
    await new Promise(resolve => this.server.close(resolve));
    this.flush();
  }
}

export function parseMetrics(text) {
  const result = { received: 0, sent: 0, events: 0 };
  const names = { nostr_client_messages_total: 'received', nostr_relay_messages_total: 'sent', nostr_events_total: 'events' };
  for (const line of text.split('\n')) {
    const match = line.match(/^(nostr_client_messages_total|nostr_relay_messages_total|nostr_events_total)(?:\{[^}]*\})?\s+([\d.e+]+)$/);
    if (match) { const n = Number(match[2]); if (Number.isSafeInteger(n) && n >= 0) result[names[match[1]]] += n; }
  }
  if (!text.includes('nostr_client_messages_total')) throw Error('Native relay metrics unavailable');
  return result;
}

export class RelayMetrics {
  constructor(store) { this.store = store; this.previous = { received: 0, sent: 0, events: 0 }; this.error = null; this.stopped = false; }
  start() {
    const poll = () => {
      if (this.stopped) return;
      this.running = this.tick().catch(() => { this.error = 'Native relay metrics could not be collected'; })
        .finally(() => { if (!this.stopped) this.timer = setTimeout(poll, 5000); });
    };
    poll();
  }
  async tick() {
    const response = await fetch('http://127.0.0.1:7777/metrics', { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw Error('Metrics unavailable');
    // Response size is bounded even if the endpoint behaves unexpectedly.
    const reader = response.body.getReader(); let text = '', size = 0;
    try {
      const decoder = new TextDecoder();
      for (;;) { const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 1024 * 1024) throw Error('Metrics too large');
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel(); }
    const current = parseMetrics(text);
    if (this.previous) {
      const delta = Object.fromEntries(Object.keys(current).map(key => [key, current[key] >= this.previous[key] ? current[key] - this.previous[key] : current[key]]));
      this.store.traffic.recordNative(delta);
    }
    this.previous = current; this.error = null;
  }
  async stop() { this.stopped = true; clearTimeout(this.timer); await this.running; }
}
