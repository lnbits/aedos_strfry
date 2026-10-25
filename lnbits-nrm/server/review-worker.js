// Durable background moderation. Only review after strfry has committed the event.
// Deletion failures retain the verdict so retries do not call the provider again.
export class ReviewWorker {
  constructor(store, moderator, relay) {
    this.store = store; this.moderator = moderator; this.relay = relay;
    this.stopped = true; this.timer = null; this.running = null; this.error = null;
  }
  start() { if (!this.store.aiModerationEnabled) return; this.stopped = false; this.schedule(0); }
  schedule(delay) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick().catch(() => { this.error = 'Background moderation failed; queued review will retry'; })
        .finally(() => { this.running = null; this.schedule(250); });
    }, delay);
  }
  async stop() { this.stopped = true; clearTimeout(this.timer); await this.running; }
  async tick(now = Date.now()) {
    if (!this.store.aiModerationEnabled || this.relay.busy || !this.relay.child) return;
    const job = this.store.nextReview(now);
    if (!job) return;
    this.store.deferReview(job.seq, now + 5000);
    const settings = this.store.settings();
    if (settings.moderation.provider === 'off') {
      this.store.record(job.event, 'review', 'Background review cancelled: moderation disabled', ['review-cancelled']);
      this.store.dropReview(job.seq); return;
    }
    if (!job.result && !await this.relay.hasEvent(job.event.id)) {
      if (now - job.created > 300000 && this.store.hasReview(job.seq)) {
        this.store.record(job.event, 'review', 'Event no longer stored; review skipped', ['review-skipped']);
        this.store.dropReview(job.seq);
      }
      return;
    }
    if (!this.store.hasReview(job.seq) || this.relay.busy) return;
    const result = job.result && job.revision === settings.revision
      ? job.result : await this.moderator.review(job.event, settings);
    // Clear-all cancels queued and in-flight jobs. Policy edits invalidate old verdicts.
    if (!this.store.hasReview(job.seq) || this.store.settings().revision !== settings.revision) return;
    this.store.saveReviewResult(job.seq, result, settings.revision);
    const offending = result.status === 'block' || (result.status === 'warn' && settings.moderation.blockWarnings);
    const failed = ['error', 'unknown'].includes(result.status);
    const remove = offending || (failed && settings.moderation.failurePolicy === 'reject');
    if (remove && !await this.relay.removeReviewed(job.event.id)) return;
    if (!this.store.hasReview(job.seq)) return;
    const reserved = new Set(['offending', 'auto-banned', 'ban-list-full', 'allow-list-priority', 'review-unavailable', 'review-complete']);
    const labels = [...result.labels.filter(label => !reserved.has(label)), offending ? 'offending' : failed ? 'review-unavailable' : 'review-complete'];
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      // Never ban on provider failures. The allow list keeps its original priority.
      if (offending && settings.moderation.autoBan && this.store.settings().revision === settings.revision) {
        labels.push(this.store.banAuthor(job.event.pubkey) ? 'auto-banned' : 'ban-list-full');
        if (this.store.settings().allow.includes(job.event.pubkey)) labels.push('allow-list-priority');
      }
      this.store.record(job.event, remove ? 'remove' : 'review',
        `${remove ? 'Removed after review' : 'Kept after review'}: ${result.reason}`, labels);
      this.store.dropReview(job.seq);
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    await this.relay.applyPolicy?.();
    this.error = null;
  }
}
