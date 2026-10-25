import { DatabaseSync } from 'node:sqlite';
import { defaults } from './config.js';
import { Traffic } from './traffic.js';

export class Store {
  constructor(path, { aiModerationEnabled = true } = {}) {
    Object.defineProperty(this, 'aiModerationEnabled', { value: aiModerationEnabled });
    this.db = new DatabaseSync(path);
    this.statements = new Map();
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, pubkey TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges (token TEXT PRIMARY KEY, nonce TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rates (pubkey TEXT NOT NULL, period INTEGER NOT NULL, bucket INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(pubkey,period));
      CREATE TABLE IF NOT EXISTS decisions (seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL, pubkey TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, labels TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, event TEXT NOT NULL,
        created INTEGER NOT NULL, next_at INTEGER NOT NULL, result TEXT, revision INTEGER
      );
      CREATE INDEX IF NOT EXISTS reviews_next ON reviews(next_at);
      CREATE INDEX IF NOT EXISTS decisions_at ON decisions(at);
    `);
    if (!this.get('settings')) this.set('settings', { ...defaults, revision: 0 });
    else {
      const settings = this.get('settings');
      if (!settings.wordFilter || settings.moderation.autoBan === undefined) {
        this.set('settings', { ...settings, wordFilter: settings.wordFilter ?? structuredClone(defaults.wordFilter),
          moderation: { ...settings.moderation, autoBan: settings.moderation.autoBan ?? false }, revision: settings.revision + 1 });
      }
    }
    if (!this.aiModerationEnabled) this.disableSavedModeration();
    this.traffic = new Traffic(this.db);
  }
  statement(sql) {
    let prepared = this.statements.get(sql);
    if (!prepared) { prepared = this.db.prepare(sql); this.statements.set(sql, prepared); }
    return prepared;
  }
  disableSavedModeration() {
    const settings = this.get('settings');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (settings.moderation.provider !== 'off' || settings.moderation.autoBan) {
        this.set('settings', { ...settings, moderation: { ...settings.moderation, provider: 'off', autoBan: false }, revision: settings.revision + 1 });
      }
      this.clearReviews();
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(key) { const row = this.statement('SELECT value FROM state WHERE key=?').get(key); return row ? JSON.parse(row.value) : undefined; }
  set(key, value) { this.statement('INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  settings() {
    const settings = this.get('settings');
    return this.aiModerationEnabled ? settings : {
      ...settings, moderation: { ...settings.moderation, provider: 'off', autoBan: false }
    };
  }
  publicSettings() {
    return { ...this.settings(), aiModerationEnabled: this.aiModerationEnabled, openaiKeySet: Boolean(this.get('openaiKey')), oracleKeySet: Boolean(this.get('oracleKey')) };
  }
  saveSettings(input) {
    const { openaiKey, oracleKey, revision, ...settings } = input;
    if (revision !== this.settings().revision) throw Object.assign(new Error('Settings changed in another session. Reload before saving.'), { statusCode: 409 });
    if (!this.aiModerationEnabled && (settings.moderation.provider !== 'off' || settings.moderation.autoBan || openaiKey || oracleKey)) {
      throw Object.assign(new Error('AI moderation is disabled by the server operator'), { statusCode: 403 });
    }
    const nextOpenaiKey = openaiKey ?? this.get('openaiKey');
    if (settings.moderation.provider === 'openai' && !nextOpenaiKey) throw Object.assign(new Error('Add an OpenAI API key before enabling moderation'), { statusCode: 400 });
    if (settings.moderation.provider === 'aedos' && !settings.moderation.oracleUrl) throw Object.assign(new Error('Add an Aedos oracle URL'), { statusCode: 400 });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.set('settings', { ...settings, revision: revision + 1 });
      if (openaiKey !== undefined) this.set('openaiKey', openaiKey);
      if (oracleKey !== undefined) this.set('oracleKey', oracleKey);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.publicSettings();
  }
  record(event, action, reason, labels = []) { this.recordMany([{ event, action, reason, labels }]); }
  recordMany(records) {
    if (!records.length) return;
    const insert = this.statement('INSERT INTO decisions (event_id,pubkey,action,reason,labels,at) VALUES (?,?,?,?,?,?)');
    const counters = this.get('counters') ?? { accept: 0, reject: 0 };
    const now = Math.floor(Date.now() / 1000);
    let last = 0;
    for (const { event, action, reason, labels = [] } of records) {
      last = Number(insert.run(event.id, event.pubkey, action, reason, JSON.stringify(labels), now).lastInsertRowid);
      counters[action] = (counters[action] ?? 0) + 1;
    }
    if (Math.floor(last / 100) !== Math.floor((last - records.length) / 100)) {
      this.statement('DELETE FROM decisions WHERE seq <= ?').run(last - 10000);
    }
    this.set('counters', counters);
  }
  decisions(limit = 50, before = Number.MAX_SAFE_INTEGER) {
    return this.statement('SELECT * FROM decisions WHERE seq < ? ORDER BY seq DESC LIMIT ?').all(before, limit)
      .map(row => ({ ...row, labels: JSON.parse(row.labels) }));
  }
  cleanup(now = Math.floor(Date.now() / 1000)) {
    this.statement('DELETE FROM sessions WHERE expires < ?').run(now);
    this.statement('DELETE FROM challenges WHERE expires < ?').run(now);
    this.statement('DELETE FROM rates WHERE (bucket + 1) * period <= ?').run(now);
    this.statement('DELETE FROM decisions WHERE seq <= (SELECT MAX(seq)-10000 FROM decisions)').run();
  }
  enqueueReview(event, now = Date.now()) {
    if (!this.aiModerationEnabled) return false;
    if (this.statement('SELECT 1 FROM reviews WHERE event_id=?').get(event.id)) return true;
    if (this.reviewCount() >= 10000) return false;
    this.statement('INSERT INTO reviews(event_id,event,created,next_at) VALUES (?,?,?,?)')
      .run(event.id, JSON.stringify(event), now, now + 1000);
    return true;
  }
  reviewCount() { return this.statement('SELECT COUNT(*) AS n FROM reviews').get().n; }
  nextReview(now = Date.now()) {
    const row = this.statement('SELECT * FROM reviews WHERE next_at <= ? ORDER BY next_at,seq LIMIT 1').get(now);
    return row ? { ...row, event: JSON.parse(row.event), result: row.result ? JSON.parse(row.result) : null } : null;
  }
  hasReview(seq) { return Boolean(this.statement('SELECT 1 FROM reviews WHERE seq=?').get(seq)); }
  deferReview(seq, nextAt) { this.statement('UPDATE reviews SET next_at=? WHERE seq=?').run(nextAt, seq); }
  saveReviewResult(seq, result, revision) {
    this.statement('UPDATE reviews SET result=?,revision=? WHERE seq=?').run(JSON.stringify(result), revision, seq);
  }
  dropReview(seq) { this.statement('DELETE FROM reviews WHERE seq=?').run(seq); }
  clearReviews() { this.db.exec('DELETE FROM reviews'); }
  banAuthor(author) {
    const settings = this.settings();
    if (!settings.block.includes(author)) {
      if (settings.block.length >= 10000) return false;
      this.set('settings', { ...settings, block: [...settings.block, author], revision: settings.revision + 1 });
    }
    return true;
  }
  close() { try { this.traffic.close(); } finally { this.db.close(); } }
}
