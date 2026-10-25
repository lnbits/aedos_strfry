# Policy and feature reference

[Back to setup](../README.md) · [Deployment and migration](deployment.md)

## Interface languages

The UI includes English, Simplified Chinese, Hindi, Spanish, French, Arabic, Bengali, Portuguese, Russian and Urdu. On first visit it chooses the first supported language in the browser's language preferences (usually inherited from the operating system), including regional variants such as `es-MX` and `pt-BR`. Unsupported preferences fall back to English. Chinese variants currently use the Simplified Chinese translation.

Use the language selector on the sign-in page or dashboard to override detection. Your choice is remembered in this browser; **Automatic (browser)** returns to detection and follows browser language changes. If browser storage is unavailable, selection still works for the current visit. Arabic and Urdu use right-to-left layouts. Counts, retention durations and dates follow the selected language; times stay in the browser's time zone.

Translations are bundled static assets served by this container, loaded only when needed. No external translation service, API key or Docker setting is required. Language selection does not change shared relay policy, NIP-11 metadata, author keys, filter entries or API values. Technical diagnostics from strfry, validation libraries and external providers retain their original text when there is no matching translation. The deletion confirmation remains the literal `CLEAR ALL NOTES` in every language.

Catalogs live in `lnbits-nrm/web/locales/`. English messages are the stable lookup keys, and `{name}` placeholders must be preserved when editing translations. `npm test` checks complete catalogs and matching placeholders; `npm run test:i18n:browser` exercises all languages and screens using an isolated preview server with fixture API responses. Native-speaker review of translations is welcome.

## Public relay policy

NRM appends an automatic plain-text policy summary to `RELAY_DESCRIPTION` in strfry's NIP-11 relay information document. It advertises default retention, rolling cleanup, the presence of author retention exceptions, per-author minute/hour limits, author restrictions, word filtering, and background AI moderation. The base description is preserved. Settings saves and automatic bans refresh the summary through strfry's normal configuration reload, without restarting connections or adding work to publishing decisions.

Individual npubs, retention override entries, blocked/allowed words, provider URLs and credentials are never included by the summary generator. Any text you explicitly put in `RELAY_DESCRIPTION` remains public. Clients decide whether to display the description and may cache it. You can inspect the current metadata with `curl -H 'Accept: application/nostr+json' https://your-relay.example`.

## Policies

| Control | Behavior |
| --- | --- |
| Allow list | When nonempty, only listed authors may publish. It takes precedence over the block list, including when an author appears in both. |
| Block list | Used only when the allow list is empty. Listed authors cannot publish. |
| Empty author lists | Neither author list restricts publishing. Retention, rate limits, word filters, and any enabled AI moderation still apply. |
| Word filters | Literal word/phrase bans with allow-listed phrase exceptions. Work independently of AI moderation; both lists start empty. |
| Default retention | Initially **0 — keep forever**, with no author overrides. Age-based deletion starts only after you configure a finite retention period. Periods are measured from signed event `created_at` and apply to all event kinds, including profiles and replaceable events. |
| Author retention overrides | Each author's period replaces the default, including a longer, shorter, or unlimited period. |
| Cleanup | Runs at startup and every **five minutes**, plus on demand. Events outside their effective retention period are deleted; incoming expired events are rejected immediately. |
| Clear all notes | Requires typing `CLEAR ALL NOTES`. Stops strfry, deletes all stored events, then restarts it. Policies, operator access, and decision history remain. New writes can arrive after restart. |
| Rate limits | Initially **60/minute and 1,000/hour per event author**. Both enabled limits apply in fixed UTC minute/hour windows; 0 disables a limit. Counters are in memory and reset when the relay/plugin restarts. Existing configured limits are preserved on upgrade. |

Author lists and rate limits govern **publishing**, not reads. NIP-42 restrictions for private event kinds remain strfry's defaults. Rate limits aggregate an author's connections and IPs, but do not prevent someone using multiple public keys. Attempts reaching word filtering consume quota even if they are rejected or later removed. strfry may reject invalid events or handle duplicate events before calling the write policy.

Fresh installations keep existing notes regardless of age during startup and scheduled retention cleanup. Upgrading an installation with saved LNbits NRM settings preserves its retention period and author overrides, including a previously saved 30-day period. Review those settings before attaching an existing relay database.

Reducing retention can delete existing data at the next cleanup. Longer retention cannot recover previously deleted events. LMDB reuses freed pages, so deleting events does not immediately shrink its database file. CLI imports and externally launched strfry processes are outside the managed write-policy path; perform imports only as a trusted operator.

## Wrapper architecture and publishing performance

NRM manages upstream strfry configuration, maintenance commands and background workers. It does not proxy WebSockets or replace strfry’s event storage. strfry retains responsibility for protocol handling, signature validation, LMDB commits and acknowledgements.

When rules are enabled, strfry launches a persistent independent plugin using its standard JSON-lines write-policy interface. The plugin holds author sets, compiled word filters, retention overrides and rate counters in memory. It checks the rules file’s identity/mtime on each request and reloads only when it changes. It never queries NRM’s HTTP server or SQLite database to make a decision. Missing, unreadable or invalid rules reject writes; unavailable reporting does not. Quotas are per author across connections in this single relay process, reset on plugin restart, and track at most 100,000 active authors per UTC hour. If that map is full, new authors are rate-limited until the hour changes rather than evicting existing counters.

**With all author/word rules, finite retention, both rate limits and AI disabled, NRM writes an empty plugin path:** publishing uses upstream strfry directly. Existing defaults remain 60/minute and 1,000/hour, so explicitly set both to zero for this mode. Background native traffic graphs still work; detailed per-event Activity is not collected in bypass mode.

While active, the plugin sends best-effort reports over a private Unix socket after sending its decision. It never waits for the manager to receive or save them. Pending reports are bounded (2 MiB plus up to 2 MiB socket output in the plugin; 8 MiB/10,000 records in the manager). Activity, counters and review candidates are flushed in background SQLite transactions every 250 ms with FULL synchronization. A slow or failed manager can lose reports without stalling publishing. Overflow warnings appear in Overview when observable; abrupt crashes or broken connections can lose records without an exact loss count. This is not a durable audit trail.

AI enables the plugin even if no rejection rules are configured, to supply review candidates without exposing private events through a new read interface. Review queue persistence happens in the background, not before relay acceptance. A full review queue does not reject writes. Saved reviews survive restart, but uncollected events are not automatically backfilled.

The independent plugin still adds JSON parsing, pipe communication and filtering work when enabled. See [the review](../SECURITY_REVIEW.md) for measured results. NRM and workers share CPU/memory with strfry; use a representative database copy and workload before migration. A stalled management event loop no longer blocks policy decisions, but a supervisor/container exit still stops the bundled service.

## Traffic graphs

Open **Traffic** for graphs over the last hour, 24 hours, 7 days, or 30 days. Native received/sent Nostr message counters and processed-event counts are polled from strfry’s `/metrics` endpoint every five seconds, including when the plugin is bypassed. These are protocol counts, not stored-event counts or bandwidth. Poll intervals spanning a restart/outage can have gaps; interval timestamps reflect collection time.

Separate detailed graphs show observed accepted/rejected plugin decisions and event JSON bytes while the plugin is enabled. Acceptance is a policy decision, not proof of a final LMDB commit or survival of later moderation. Detailed reporting is best-effort and can miss records during outages or overload. Native metrics do not reconstruct missing Activity or AI jobs.

Anonymous minute counters are saved every 10 seconds and during graceful shutdown, retaining 30 days. No note text or author identities are saved in traffic counters. Clear-all notes leaves traffic history intact. Historical Activity is not backfilled. Missing observations appear as zero, including downtime; the current interval is partial. The page refreshes every 10 seconds and supports both themes, mobile layouts and keyboard/touch inspection.

## Word and phrase filters

Open **Word filters**, enter one word or phrase per line in the block and allow lists, and select **Save policy**. Each list accepts up to 200 entries of up to 200 characters each. Clear the block list to disable word filtering. Existing installations receive empty lists on upgrade without changing their saved policies or secrets.

Matching is case-insensitive, normalizes Unicode compatibility forms (NFKC), and treats repeated whitespace/newlines as one space. It matches whole words or literal phrases, not arbitrary substrings or regular expressions: blocking `cat` does not reject `catalog`. Unicode letters, combining marks, digits, and underscores count as word characters; punctuation is literal.

An allow-listed phrase exempts only blocked occurrences **fully contained inside that phrase**. For example, block `scam` and allow `scam prevention`: `Scam prevention tips` passes this filter, while `scam prevention and another scam` is still rejected. A word appearing in both lists is exempted, but putting an unrelated allowed word in a note does not override other bans. The allow list is a set of exceptions, not a requirement that every note contain an allowed term.

Rules check the incoming event's `content` text, before the AI provider, **even with AI disabled**. They apply to new writes of all event kinds; they cannot decrypt private messages or inspect media, and do not delete existing notes. Allowed text still has to pass author access, retention, rate limits, topic-tag rules, and AI checks. Rejections appear in Activity with the `word-filter` label and a generic reason without logging the matched note text. The separate blocked-topic-tag settings retain their existing behavior and run only when AI moderation is enabled.

## AI moderation

**Deployment security:** the latest [security review](../SECURITY_REVIEW.md) records unresolved native media-parser advisories. Start the server deployment with `AI_MODERATION_ENABLED=false`; video processing shares the relay container and is not separately sandboxed. Keep management private or behind HTTPS, and test a consistent database copy before migration.

For SaaS deployments, set **`AI_MODERATION_ENABLED=false`** in the container environment to disable AI moderation at the server level. With the supplied Compose file, set it in the repository-root `.env` or launch with:

```bash
AI_MODERATION_ENABLED=false docker compose up --build -d
```

For `docker run`, add `-e AI_MODERATION_ENABLED=false`. Keep this value in your deployment configuration so later recreations retain it. The default is `true`, which makes AI available but leaves the provider off until configured. Accepted values are `true`/`false` or `1`/`0` (case-insensitive); other values stop startup with a configuration error.

When disabled, startup turns off any previously saved provider and automatic AI bans, and discards pending reviews and deletion jobs. No AI worker starts, no new reviews are queued, and no AI provider calls or moderation media processing occur. Authenticated administrators cannot enable either provider or automatic AI bans through the API, and the UI displays an unavailable message instead of AI controls. Author lists, local word filters, retention, rate limits, and manual bans remain usable. Existing notes and saved API keys are retained. Only changing the container environment and recreating the container restores availability; the provider then needs to be explicitly enabled again. This is a runtime restriction and uses the same image.

When available, select a provider in **AI moderation**, configure it, and save:

* **OpenAI:** supply an API key; the default model is `omni-moderation-latest`. Reviews event text, supported images, and video frames sampled by the bundled ffmpeg. Uses the official [Moderations API](https://developers.openai.com/api/reference/resources/moderations/methods/create).
* **Connected Aedos oracle:** supply the base URL of an existing Aedos oracle and, if configured there, its API key. Sends the signed event to `/v1/check` with `wait: true`. The connected oracle determines its review coverage and verdicts.

**AI moderation runs after acceptance.** Author access, retention age, rate limits, and word filters remain immediate publishing checks. With a provider enabled, the independent plugin sends the signed event to background collection without waiting for its receipt or persistence. Collected events are durably queued, and the worker checks strfry storage before review. Clients can receive a note before its review; removal cannot retract copies already delivered. Only new events passing the managed write policy are queued, not historical notes or trusted CLI imports. Ephemeral events are not stored by strfry and cannot be removed this way.

`block` verdicts remove the stored event. Warnings remove it by default, with an option to keep them. Unknown, failed, oversized, unsupported, or timed-out reviews follow the configured fallback: **remove by default**, or explicitly keep. Existing `failurePolicy: reject/accept` settings retain their values but now mean remove/keep after acceptance. Blocked hashtags and Nostr `t` tags trigger removal in the background without a provider call.

**Automatically ban offending authors** is optional and defaults to off, including on upgrade. When enabled, block verdicts and warnings configured for removal add the author to the block list. Errors, timeouts, and unknown results never trigger bans. You can also select **Ban author** beside an offending review in Activity. These actions preserve your authoritative allow list: an author on it can still publish even if added to the block list. Remove that author from the allow list to revoke their access; bans do not purge all of an author's historical notes. The block list is limited to 10,000 authors; a full list is reported in Activity for automatic bans.

Direct OpenAI media discovery covers image/video URLs with recognized file extensions, Nostr `imeta` URLs, and `url` tags. It does not crawl arbitrary linked web pages, discover extensionless links outside media tags, review audio, or inspect streaming playlists. Supported downloads are JPEG, PNG, GIF, WebP, MP4, WebM, QuickTime, and Ogg video. Animated images are subject to the provider's image handling; full animation review is not guaranteed. Limits are 10 MB/image, 40 MB/video, 1–8 attachments, and 1–8 sampled frames/video. Sampling does not inspect every video frame. Direct media downloads reject private/local IPs, validate redirects, and pin DNS results to connections.

Enabled providers receive note content and supported media. Downloaded media and frames are temporary and removed after review. API keys are stored only in the private settings database and are never returned through the API. They are not encrypted against access by the host administrator; protect the data volume and backups. The durable review queue temporarily stores signed note payloads in SQLite until review finishes or is cancelled. The separate Activity log records event IDs, author public keys, decisions, and labels, without retaining note text or media. It keeps about 10,000 recent decisions (at most 10,099 between pruning batches); counts of policy accepts/rejections are cumulative. In-memory AI verdict caching is bounded and invalidated by policy changes.

The background worker reviews one event at a time with a 2–40 second review deadline. Slow providers increase the backlog without holding up subsequent publishing. Pending jobs and completed verdicts awaiting deletion survive restarts; deletion errors are retried. The queue is limited to **10,000 events**: when full, publishing continues and new review candidates are dropped with a warning. Events lost before queue persistence are not automatically recovered, and the unavailable-review removal setting cannot act on events that were never queued. Queue size and worker errors appear in AI moderation. This is not yet a benchmarked high-throughput moderation service. Unavailable or invalid plugin rules reject publishing; an unavailable management/reporting service does not.

Policy changes invalidate in-flight verdicts and pending jobs use the current policy on retry. Disabling moderation cancels queued reviews without removing notes. Clear-all cancels pending and in-flight jobs, preventing later bans from those cancelled jobs. Reviews wait for strfry to commit the event; jobs whose events remain absent for five minutes are skipped, including replaced, deleted, or ephemeral events.

## Available storage

**Overview** and **Storage** show available disk space, total capacity, used space, and a usage bar. Figures refresh with the overview every five seconds and come from the filesystem containing the relay database directory, including a separately mounted database volume. Available space excludes filesystem-reserved blocks that the relay cannot use. Values describe the shared filesystem, not a dedicated relay allowance; separate hosting quotas may be lower. If the filesystem cannot be queried, the UI reports that space is unavailable rather than showing a misleading zero. Reading disk capacity does not scan notes or alter the database. Stored event counts use LMDB table metadata through `mdb_stat`, with a one-minute cache, rather than scanning the event history.
