// Public text only. Never interpolate list entries, author overrides, credentials,
// provider URLs or model configuration into relay metadata.
export function policyDescription(description, settings) {
  const parts = [];
  const days = settings.retentionDays;
  parts.push(days > 0
    ? `Default age-based retention: ${days} ${days === 1 ? 'day' : 'days'} from event creation.`
    : 'Default age-based retention: unlimited.');
  if (settings.retentionOverrides.length) parts.push('Author-specific retention exceptions apply.');
  if (days > 0 || settings.retentionOverrides.some(row => row.days > 0)) {
    parts.push('Expired events are removed on a rolling basis approximately every five minutes. Incoming events beyond their author’s retention period are rejected.');
  }
  const limits = [];
  if (settings.rate.perMinute) limits.push(`${settings.rate.perMinute} attempts per UTC minute`);
  if (settings.rate.perHour) limits.push(`${settings.rate.perHour} attempts per UTC hour`);
  parts.push(limits.length
    ? `Per-author publishing limits: ${limits.join(' and ')}. Counters reset when the relay policy process restarts.`
    : 'No per-author publishing rate limits.');
  if (settings.allow.length) parts.push('Publishing is restricted to approved authors; approval takes precedence over author blocking.');
  else if (settings.block.length) parts.push('Author blocking is enabled.');
  else parts.push('No author allow/block restrictions.');
  parts.push(settings.wordFilter.block.length ? 'Word and phrase filtering is enabled.' : 'Word and phrase filtering is disabled.');
  if (settings.moderation.provider !== 'off') {
    parts.push('AI moderation reviews accepted events in the background and may remove them afterward. Review coverage is best-effort.');
    if (settings.moderation.autoBan) parts.push('Offending authors may also be added to the block list; author approvals retain priority.');
  } else parts.push('AI moderation is disabled.');
  return [description?.trim(), `Relay policy: ${parts.join(' ')}`].filter(Boolean).join('\n\n');
}
