import { compileWordFilter } from './word-filter.js';

export function needsPlugin(settings) {
  return Boolean(settings.allow.length || settings.block.length || settings.wordFilter.block.length ||
    settings.retentionDays || settings.retentionOverrides.some(r => r.days > 0) ||
    settings.rate.perMinute || settings.rate.perHour || settings.moderation.provider !== 'off');
}

// No database or manager connection. One persistent instance per strfry writer.
export class Policy {
  constructor(settings, { maxAuthors = 100000 } = {}) {
    this.rates = new Map(); this.maxAuthors = maxAuthors; this.hour = -1;
    this.update(settings);
  }
  update(settings) {
    this.settings = settings;
    this.allow = new Set(settings.allow); this.block = new Set(settings.block);
    this.retention = new Map(settings.retentionOverrides.map(r => [r.pubkey, r.days]));
    this.words = compileWordFilter(settings.wordFilter);
  }
  takeRate(author, rate, now) {
    if (!rate.perMinute && !rate.perHour) return true;
    const hour = Math.floor(now / 3600), minute = Math.floor(now / 60);
    if (hour !== this.hour) { this.rates.clear(); this.hour = hour; }
    let row = this.rates.get(author);
    // Bound memory without evicting active counters and granting extra quota.
    if (!row && this.rates.size >= this.maxAuthors) return false;
    row ??= { minute, minuteCount: 0, hourCount: 0 };
    if (row.minute !== minute) { row.minute = minute; row.minuteCount = 0; }
    if ((rate.perMinute && row.minuteCount >= rate.perMinute) || (rate.perHour && row.hourCount >= rate.perHour)) return false;
    row.minuteCount++; row.hourCount++;
    this.rates.set(author, row);
    return true;
  }
  decide(message, now = Math.floor(Date.now() / 1000)) {
    const event = message?.event;
    const finish = (action, msg = '') => ({ id: event?.id ?? '', action, msg });
    if (message?.type !== 'new' || !/^[a-f0-9]{64}$/.test(event?.id) || !/^[a-f0-9]{64}$/.test(event?.pubkey) ||
        !Number.isInteger(event.created_at) || typeof event.content !== 'string' || !Array.isArray(event.tags) ||
        !event.tags.every(t => Array.isArray(t) && t.every(v => typeof v === 'string'))) {
      return finish('reject', 'invalid: malformed plugin request');
    }
    if (this.allow.size ? !this.allow.has(event.pubkey) : this.block.has(event.pubkey)) {
      return finish('reject', this.allow.size ? 'blocked: author is not on the allow list' : 'blocked: author is on the block list');
    }
    const days = this.retention.get(event.pubkey) ?? this.settings.retentionDays;
    if (days > 0 && event.created_at <= now - days * 86400) return finish('reject', 'blocked: event exceeds author retention period');
    if (!this.takeRate(event.pubkey, this.settings.rate, now)) return finish('reject', 'rate-limited: author publish limit exceeded');
    if (this.words(event.content)) return finish('reject', 'blocked: note contains a banned word or phrase');
    return finish('accept');
  }
}
