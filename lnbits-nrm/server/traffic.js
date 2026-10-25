const MINUTE = 60000;
const RETENTION = 30 * 86400000;
const ranges = new Map([
  ['1h', { step: MINUTE, count: 60 }],
  ['24h', { step: 15 * MINUTE, count: 96 }],
  ['7d', { step: 60 * MINUTE, count: 168 }],
  ['30d', { step: 240 * MINUTE, count: 180 }]
]);

// Only anonymous counters enter this collector. No additional per-event DB write.
export class Traffic {
  constructor(db, now = Date.now()) {
    this.db = db;
    this.pending = new Map();
    this.nativePending = new Map();
    this.error = null;
    this.lastCleanup = null;
    db.exec(`CREATE TABLE IF NOT EXISTS traffic_minutes (
      at INTEGER PRIMARY KEY, accept INTEGER NOT NULL, reject INTEGER NOT NULL, bytes INTEGER NOT NULL
    );`);
    db.prepare('INSERT OR IGNORE INTO state(key,value) VALUES (?,?)').run('trafficStartedAt', JSON.stringify(now));
    this.startedAt = JSON.parse(db.prepare('SELECT value FROM state WHERE key=?').get('trafficStartedAt').value);
    db.exec('CREATE TABLE IF NOT EXISTS relay_minutes (at INTEGER PRIMARY KEY, received INTEGER NOT NULL, sent INTEGER NOT NULL, events INTEGER NOT NULL)');
    this.nativeUpsert = db.prepare('INSERT INTO relay_minutes VALUES (?,?,?,?) ON CONFLICT(at) DO UPDATE SET received=received+excluded.received,sent=sent+excluded.sent,events=events+excluded.events');
    this.upsert = db.prepare(`INSERT INTO traffic_minutes VALUES (?,?,?,?) ON CONFLICT(at) DO UPDATE SET
      accept=accept+excluded.accept, reject=reject+excluded.reject, bytes=bytes+excluded.bytes`);
    this.timer = setInterval(() => {
      try { this.flush(); }
      catch { this.error = 'Traffic history could not be saved. Recent counters are held in memory until storage recovers.'; }
    }, 10000);
    this.timer.unref();
  }
  record(action, bytes, now = Date.now()) {
    if (action !== 'accept' && action !== 'reject') return;
    const at = Math.floor(now / MINUTE) * MINUTE;
    const row = this.pending.get(at) ?? { at, accept: 0, reject: 0, bytes: 0 };
    row[action]++;
    row.bytes += bytes;
    this.pending.set(at, row);
  }
  recordNative(delta, now = Date.now()) {
    const at = Math.floor(now / MINUTE) * MINUTE;
    const row = this.nativePending.get(at) ?? { at, received: 0, sent: 0, events: 0 };
    for (const key of ['received', 'sent', 'events']) row[key] += delta[key];
    this.nativePending.set(at, row);
  }
  flush(now = Date.now()) {
    const minute = Math.floor(now / MINUTE) * MINUTE;
    const cutoff = minute - RETENTION;
    for (const at of this.pending.keys()) if (at < cutoff) this.pending.delete(at);
    for (const at of this.nativePending.keys()) if (at < cutoff) this.nativePending.delete(at);
    if (!this.pending.size && !this.nativePending.size && this.lastCleanup === minute) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of this.pending.values()) this.upsert.run(row.at, row.accept, row.reject, row.bytes);
      for (const row of this.nativePending.values()) this.nativeUpsert.run(row.at, row.received, row.sent, row.events);
      if (this.lastCleanup !== minute) this.db.prepare('DELETE FROM relay_minutes WHERE at < ?').run(cutoff);
      if (this.lastCleanup !== minute) this.db.prepare('DELETE FROM traffic_minutes WHERE at < ?').run(cutoff);
      this.db.exec('COMMIT');
      this.pending.clear();
      this.nativePending.clear();
      this.lastCleanup = minute;
      this.error = null;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  snapshot(range = '24h', now = Date.now()) {
    const config = ranges.get(range);
    if (!config) throw Object.assign(new Error('Traffic range must be 1h, 24h, 7d or 30d'), { statusCode: 400 });
    const { step, count } = config;
    const from = Math.floor(now / step) * step - (count - 1) * step;
    const points = Array.from({ length: count }, (_, i) => ({ at: from + i * step, accept: 0, reject: 0, bytes: 0 }));
    const add = row => {
      const index = Math.floor((row.at - from) / step);
      if (index < 0 || index >= count || row.at > now) return;
      for (const key of ['accept', 'reject', 'bytes']) points[index][key] += row[key];
    };
    for (const row of this.db.prepare(`SELECT CAST((at - ?) / ? AS INTEGER) * ? + ? AS at,
      SUM(accept) AS accept, SUM(reject) AS reject, SUM(bytes) AS bytes
      FROM traffic_minutes WHERE at >= ? AND at <= ? GROUP BY 1`).all(from, step, step, from, from, now)) add(row);
    for (const row of this.pending.values()) add(row);
    const totals = points.reduce((total, row) => ({ accept: total.accept + row.accept, reject: total.reject + row.reject, bytes: total.bytes + row.bytes }), { accept: 0, reject: 0, bytes: 0 });
    const nativePoints = points.map(row => ({ at: row.at, received: 0, sent: 0, events: 0 }));
    const addNative = row => {
      const index = Math.floor((row.at - from) / step);
      if (index < 0 || index >= count || row.at > now) return;
      for (const key of ['received', 'sent', 'events']) nativePoints[index][key] += row[key];
    };
    for (const row of this.db.prepare('SELECT * FROM relay_minutes WHERE at >= ? AND at <= ?').all(from, now)) addNative(row);
    for (const row of this.nativePending.values()) addNative(row);
    const nativeTotals = nativePoints.reduce((a, row) => ({ received: a.received + row.received, sent: a.sent + row.sent, events: a.events + row.events }), { received: 0, sent: 0, events: 0 });
    return { range, from, until: now, step, startedAt: this.startedAt, points, totals, nativePoints, nativeTotals, error: this.error };
  }
  close() { clearInterval(this.timer); this.flush(); }
}
