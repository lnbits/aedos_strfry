import { z } from 'zod';
import { nip19 } from 'nostr-tools';
import { normalizeText } from './word-filter.js';

// Deployment capabilities are read once at startup, never from saved UI settings.
export function runtimeOptions(env = process.env) {
  const flag = (name, fallback) => {
    if (env[name] === undefined) return fallback;
    const normalized = env[name].trim().toLowerCase();
    if (['true', '1'].includes(normalized)) return true;
    if (['false', '0'].includes(normalized)) return false;
    throw new Error(name + ' must be true, false, 1, or 0');
  };
  return { aiModerationEnabled: flag('AI_MODERATION_ENABLED', true), requireExistingDb: flag('REQUIRE_EXISTING_DB', false) };
}

export function pubkey(value) {
  if (typeof value !== 'string') throw new Error('Enter a valid npub or 64-character public key');
  const key = value.trim();
  if (/^[0-9a-f]{64}$/i.test(key)) return key.toLowerCase();
  try {
    const decoded = nip19.decode(key);
    if (decoded.type === 'npub') return decoded.data;
  } catch {}
  throw new Error('Enter a valid npub or 64-character public key');
}

const key = z.string().transform((v, ctx) => {
  try { return pubkey(v); } catch (error) { ctx.addIssue({ code: 'custom', message: error.message }); return z.NEVER; }
});
const days = z.number().int().min(0).max(36500);
const keyList = z.array(key).max(10000).transform(v => [...new Set(v)]);
const words = z.array(z.string().max(1000).transform(normalizeText).pipe(z.string().min(1).max(200)))
  .max(200).transform(values => [...new Set(values)]);
export const settingsSchema = z.object({
  allow: keyList,
  block: keyList,
  wordFilter: z.object({ allow: words, block: words }).strict(),
  retentionDays: days,
  retentionOverrides: z.array(z.object({ pubkey: key, days }).strict()).max(10000)
    .refine(rows => new Set(rows.map(r => r.pubkey)).size === rows.length, 'Each author can have only one retention override'),
  rate: z.object({ perMinute: z.number().int().min(0).max(1000000), perHour: z.number().int().min(0).max(10000000) }).strict(),
  moderation: z.object({
    provider: z.enum(['off', 'openai', 'aedos']),
    oracleUrl: z.string().max(2048).refine(v => !v || validEndpoint(v), 'Enter an HTTP(S) oracle URL without credentials or query parameters'),
    model: z.string().min(1).max(100).regex(/^[a-zA-Z0-9._:-]+$/),
    blockWarnings: z.boolean(),
    autoBan: z.boolean().default(false),
    failurePolicy: z.enum(['reject', 'accept']),
    timeoutSeconds: z.number().int().min(2).max(40),
    maxMedia: z.number().int().min(1).max(8),
    videoFrames: z.number().int().min(1).max(8),
    blockedTags: z.array(z.string().min(1).max(50).regex(/^[\p{L}\p{N}_-]+$/u)).max(100)
  }).strict(),
  openaiKey: z.string().max(500).optional(),
  oracleKey: z.string().max(500).optional(),
  revision: z.number().int().min(0).optional()
}).strict();

function validEndpoint(value) {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; } catch { return false; }
}

export const defaults = {
  // Fresh installations must not expire an existing relay database on first startup.
  allow: [], block: [], retentionDays: 0, retentionOverrides: [],
  wordFilter: { allow: [], block: [] },
  rate: { perMinute: 60, perHour: 1000 },
  moderation: {
    provider: 'off', oracleUrl: '', model: 'omni-moderation-latest', blockWarnings: true,
    autoBan: false, failurePolicy: 'reject', timeoutSeconds: 30, maxMedia: 4, videoFrames: 4,
    blockedTags: ['csam', 'pedo', 'loli']
  }
};

export function retentionDays(settings, author) {
  return settings.retentionOverrides.find(r => r.pubkey === author)?.days ?? settings.retentionDays;
}
export function expired(event, settings, now = Math.floor(Date.now() / 1000)) {
  const days = retentionDays(settings, event.pubkey);
  return days > 0 && event.created_at <= now - days * 86400;
}

export function accessReason(settings, author) {
  if (settings.allow.length) return settings.allow.includes(author) ? null : 'blocked: author is not on the allow list';
  return settings.block.includes(author) ? 'blocked: author is on the block list' : null;
}
