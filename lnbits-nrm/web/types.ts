export type Settings = {
  allow: string[]; block: string[]; retentionDays: number;
  wordFilter: { allow: string[]; block: string[] };
  retentionOverrides: { pubkey: string; days: number }[];
  rate: { perMinute: number; perHour: number };
  moderation: {
    provider: 'off' | 'openai' | 'aedos'; oracleUrl: string; model: string;
    blockWarnings: boolean; autoBan: boolean; failurePolicy: 'reject' | 'accept'; timeoutSeconds: number;
    maxMedia: number; videoFrames: number; blockedTags: string[];
  };
  aiModerationEnabled: boolean;
  revision: number; openaiKeySet: boolean; oracleKeySet: boolean;
};
export type Job = { type: string; status: string; startedAt: number; finishedAt?: number; deleted: number; error: string | null };
export type DiskSpace = { totalBytes: number; usedBytes: number; availableBytes: number; reservedBytes: number };
export type Overview = {
  disk: DiskSpace | null;
  online: boolean; relayUrl: string; name: string; eventCount: number | null; countedAt: number | null;
  databaseBytes: number; counters: { accept: number; reject: number }; maintenance: Job | null;
  pluginEnabled: boolean; appliedRevision: number; reportingError: string | null;
  policyRevision: number; moderationQueue: number; moderationError: string | null;
  error: string | null; uptimeSeconds: number;
};
export type Decision = { seq: number; event_id: string; pubkey: string; action: string; reason: string; labels: string[]; at: number };
export type Session = { authenticated: boolean; configured?: boolean; pubkey?: string; npub?: string };
export type NostrEvent = { kind: number; content: string; created_at: number; tags: string[][]; pubkey?: string; sig?: string; id?: string };
declare global {
  interface Window {
    nostr?: { getPublicKey(): Promise<string>; signEvent(event: NostrEvent): Promise<NostrEvent> };
  }
}

export type TrafficRange = '1h' | '24h' | '7d' | '30d';
export type TrafficPoint = { at: number; accept: number; reject: number; bytes: number };
export type TrafficData = {
  range: TrafficRange; from: number; until: number; step: number; startedAt: number;
  pluginEnabled: boolean; reportingError: string | null;
  nativePoints: { at: number; received: number; sent: number; events: number }[];
  nativeTotals: { received: number; sent: number; events: number };
  points: TrafficPoint[]; totals: { accept: number; reject: number; bytes: number }; error: string | null;
};
