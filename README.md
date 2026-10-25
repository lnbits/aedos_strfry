# LNbits NRM

**LNbits Nostr Relay Manager**

LNbits NRM runs strfry and its management UI in **one Docker image and one container**. The UI reuses the supplied Aedos dashboard's styling and light/dark themes, with a white lightning bolt in dark mode and a black bolt in light mode. Operator sign-in uses a NIP-07 Nostr browser extension instead of a username and password.

The application is in `lnbits-nrm/`; run Docker commands from this repository root. This is the application source folder and must be kept. The original reference checkouts are no longer needed: UI styles and lightning bolt assets are included in the app, and Docker downloads the pinned strfry source during the build. An optional local `strfry/` reference checkout remains excluded from Git and the Docker build context.

## Start

For a new installation, copy the example configuration (keep an existing `.env` when upgrading):

```bash
cp .env.example .env
```

Set `ADMIN_NPUBS` in `.env` to your extension's **public npub** (or 64-character hex public key). Multiple operator keys may be separated by commas. Never supply an nsec or private key.

```env
ADMIN_NPUBS=npub1your_actual_public_key
PUBLIC_ORIGIN=http://localhost:3000
RELAY_URL=ws://localhost:7777
```

```bash
docker compose build
docker compose run --rm setup
docker compose up -d
```

The example `.env` selects host storage using `COMPOSE_FILE=compose.yaml:compose.host.yaml`. By default, relay events live in `./strfry-db/` and manager settings live in `./data/`, relative to the repository root. The one-time setup command creates these directories and prepares empty directories for UID/GID 1000. Existing files are only checked for access; setup does not modify or delete them. Fill in your operator npub and public addresses before starting.

For later updates, use `docker compose up --build -d` with the same `.env` and directories.

Open **http://localhost:3000**, enable your Nostr browser extension, and choose **Connect Nostr extension**. Approve the one-time sign-in event. Clients connect to **ws://localhost:7777**.

The image build downloads strfry directly from `https://github.com/hoytech/strfry.git` at the full commit SHA pinned by `STRFRY_COMMIT` in the Dockerfile, checks out its submodules, and compiles it **without NRM source patches**. Later builds reuse that layer. No local strfry checkout, repository submodule, or symbolic link is needed. The final image includes the relay binary and its license; it needs no GitHub connection at startup. No separate Postgres, Redis, oracle, or worker container is needed. AI is optional and initially off.

To upgrade strfry deliberately, update the full `STRFRY_COMMIT` SHA in the Dockerfile, rebuild, and run the integration checks below. Rebuilding does not automatically follow an upstream branch or pick a newer relay version. Fresh builds require network access to GitHub and the package registries.

Without `ADMIN_NPUBS`, management remains locked; the first visitor cannot claim the installation. The relay still runs with the default policies. Restart after changing environment variables. Active plugins reload the atomically saved rules file on their next request. Enabling or bypassing the plugin uses strfry’s normal config reload and can take a few seconds; it does not disconnect clients. Failed application is shown in Overview and retried.

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

The independent plugin still adds JSON parsing, pipe communication and filtering work when enabled. See [the review](SECURITY_REVIEW.md) for measured results. NRM and workers share CPU/memory with strfry; use a representative database copy and workload before migration. A stalled management event loop no longer blocks policy decisions, but a supervisor/container exit still stops the bundled service.

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

**Deployment security:** the latest [security review](SECURITY_REVIEW.md) records unresolved native media-parser advisories. Start the server deployment with `AI_MODERATION_ENABLED=false`; video processing shares the relay container and is not separately sandboxed. Keep management private or behind HTTPS, and test a consistent database copy before migration.

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

## Deployment and data

The application folder, package, and image use `lnbits-nrm`. The short product name is **LNbits NRM** and the full name is **LNbits Nostr Relay Manager**. The connected Aedos oracle is a separate service and retains its name.

The base `compose.yaml` retains the `aedos` service key and `aedos_data` volume key so existing named-volume deployments upgrade in place with `docker compose up --build -d`. Existing `.env` files are not rewritten; without the host override, storage remains in the existing named volume. Keep using the same Compose project name and data volume when upgrading. Existing `/data/aedos.sqlite` databases (including their WAL files) are reopened in place; new installations use `/data/lnbits-nrm.sqlite`. Existing session cookies and theme preferences remain supported.

### Host-directory storage

New installations use the optional `compose.host.yaml` override selected in the example `.env`. Both paths are configurable:

| Variable | Default host path | Container path |
| --- | --- | --- |
| `NRM_DATA_DIR` | `./data` | `/data` (settings, sessions, traffic history, generated configuration) |
| `STRFRY_DB_DIR` | `./strfry-db` | `/data/strfry-db` (relay database) |

Keep the two host directories separate. The regular application refuses missing host directories; `docker compose run --rm setup` creates them deliberately. Setup runs once as root with limited capabilities, then checks access as UID/GID 1000. It changes ownership and permissions only on empty directories and never changes existing database files. The relay and UI continue to run unprivileged.

For the existing dockurr relay layout discussed here, use:

```env
COMPOSE_FILE=compose.yaml:compose.host.yaml
NRM_DATA_DIR=/opt/lnbits-nrm/data
STRFRY_DB_DIR=/opt/strfry/strfry-db
REQUIRE_EXISTING_DB=true
AI_MODERATION_ENABLED=false
```

The host database stays at `/opt/strfry/strfry-db/data.mdb`; its container path changes from `/app/strfry-db` to `/data/strfry-db`. The original `/opt/strfry/strfry.conf` remains untouched. LNbits NRM generates its own config in its separate settings directory, so compare any custom relay options before cutover.

**Before switching an existing relay:** check binary/database compatibility on a backup copy, stop the original relay for a consistent final backup, and ensure the database directory and its files are readable/writable by UID/GID 1000. Keep the original image, configuration, and backup for rollback. Only then run setup and start the new container. Use a fresh manager settings directory to get retention `0` with no overrides; a reused settings directory retains its saved retention rules. Preserve the public relay address and reverse-proxy routing. Do not run both deployments against this directory during the migration.

`REQUIRE_EXISTING_DB=true` makes both setup and normal startup refuse a missing or empty `data.mdb` before creating manager state or starting strfry. It verifies the file's presence, not database compatibility or integrity. Leave it false for a new empty relay. If setup reports a permissions error, adjust permissions on the intended database only after backup and shutdown; setup will not recursively chown imported files.

If the target server has limited memory, build on another machine with the same CPU architecture, transfer the image with `docker save` / `docker load`, then run setup and `docker compose up -d --no-build` there.

### Files inside the container

Data files:

```text
/data/lnbits-nrm.sqlite  settings, keys, sessions, counters, decision log (new installs)
/data/strfry-db/         strfry LMDB event database
/data/strfry.conf        generated relay configuration
/data/policy.json        atomic rules snapshot for the independent plugin
/data/reporting.sock     private, best-effort background reporting socket
```

The container runs as the unprivileged `node` user, under `tini`, with both processes supervised. If strfry exits unexpectedly the container exits so Compose can restart it. `/api/health` checks relay availability and reports a detected write-policy failure until a publishing decision succeeds again. It does not perform a test write or detect every possible storage failure in advance. Health probes are briefly cached and coalesced. Docker health status alone does not trigger a Compose restart. Compose drops Linux capabilities and disables privilege escalation.

For remote access, terminate HTTPS/WSS at your reverse proxy. Set `PUBLIC_ORIGIN` to the **exact browser origin** (scheme, hostname, and optional port), and `RELAY_URL` to the externally reachable WS/WSS address. Secure cookies are selected automatically for HTTPS origins. The UI port binds to localhost by default; change `UI_BIND` if the proxy needs another interface. Forward WebSocket upgrades to port 7777. The UI and relay are separate ports in the same image.

Environment variables are listed in [.env.example](.env.example). `RELAY_NAME`, `RELAY_DESCRIPTION`, `RELAY_PUBKEY`, and `RELAY_CONTACT` populate the relay's NIP-11 metadata. `RELAY_PUBKEY` accepts an npub or hexadecimal public key, publishes it as hexadecimal, and defaults to the first admin key when omitted. It does not grant management access. `RELAY_CONTACT` is an optional public address such as `mailto:operator@example.com`. Operator public keys are boot configuration, separate from the publishing allow list; being an operator does not bypass relay policy.

```bash
docker compose logs -f aedos
docker compose restart aedos
docker compose down
```

`down` retains data. With host mounts, back up both `NRM_DATA_DIR` and `STRFRY_DB_DIR`; Docker container recreation does not remove these host directories. With the original named-volume layout, back up the entire data volume and avoid **`down -v`**, which deletes that volume. Stop the container for a consistent backup, then start it again. Keep API keys and sessions in backups private. Restored files must be readable/writable by UID/GID 1000.

To run the built image without Compose using the original named-volume layout:

```bash
docker build -t lnbits-nrm:local .
docker run -d --name lnbits-nrm --restart unless-stopped \
  --cap-drop ALL --security-opt no-new-privileges:true \
  -p 127.0.0.1:3000:3000 -p 7777:7777 \
  -e ADMIN_NPUBS=npub1your_actual_public_key \
  -e PUBLIC_ORIGIN=http://localhost:3000 \
  -e RELAY_URL=ws://localhost:7777 \
  -v aedos_data:/data lnbits-nrm:local
```

## Development and validation

Requires Node 24+; Docker compiles strfry and supplies ffmpeg. The frontend is Svelte 5/Vite, the API is Fastify, settings use Node's built-in SQLite, and Schnorr signatures/npubs use `nostr-tools`.

```bash
cd lnbits-nrm
npm ci
npm run check
npm test
npm run build
```

End-to-end validation uses a disposable container, anonymous data volume, localhost-only random ports, and test signing keys. It tests the real relay's WebSocket writes, access rules, persistence, retention, moderation responses, ffmpeg video sampling, clear-all, and the browser UI. It never uses an existing relay volume or calls a live AI provider.

```bash
# Build the runtime image from the repository root first.
docker build -t lnbits-nrm:local .
cd lnbits-nrm
npx playwright install chromium
npm run test:integration
```

Run `npm run test:integration:ai-disabled` to verify the operator restriction against a disposable Docker volume seeded with a previously enabled provider and pending review. It checks API bypass attempts, continued relay publishing, restart behavior, and the unavailable UI. Both integration commands accept the browser options below.

Run `npm run test:integration:relay-info` to verify the real NIP-11 response, privacy of rule values, live metadata refresh, plugin bypass, and continued publishing on an existing WebSocket. It uses a disposable container and no external AI service.

Run `npm run test:integration:host-storage` to verify the actual Compose host mounts, empty-directory initialization, permissions checks, missing-database guard, and preservation of notes/settings across container recreation. It uses only temporary host directories, a unique Compose project, and disposable test keys.

Use `SKIP_BROWSER=1 npm run test:integration` for relay-only integration checks, or `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome` for an existing browser. Browser screenshots are saved to `lnbits-nrm/test-results/` and ignored by Git. Live provider acceptance requires your own configured credentials; mock provider and failure-path tests cannot validate an API account.

Run `npm run test:integration:reliability` for concurrent publishing under one-CPU/512-MiB limits, comparison with the same bare strfry binary, plugin bypass or independent filtering, in-memory quotas, missing-rule rejection, Activity-storage fault injection, continued enforcement while the manager is suspended, native metrics, restart/crash recovery, and database/count verification. `NRM_TEST_EVENTS=10000 NRM_TEST_WARMUP=500` selects a longer warmed-up run; `NRM_TEST_FILTER=1` enables a word filter for comparison; `NRM_TEST_CONNECTIONS` defaults to 16, `NRM_TEST_MANAGED_FIRST=1` reverses test order, and `NRM_TEST_IMAGE` selects another image. Its databases and containers are disposable. See [the security and reliability review](SECURITY_REVIEW.md) for findings, results and migration limits.

For local development with an already compiled strfry binary, ffmpeg, and `mdb_stat` (from `lmdb-utils`) on PATH:

```bash
cd lnbits-nrm
npm ci
npm run build
ADMIN_NPUBS=your_public_key STRFRY_BIN=/absolute/path/to/strfry npm start
```

Local and Docker builds use the same standard upstream plugin protocol. No native bridge or strfry source patch is needed.

For frontend hot reload, run `npm run dev` in a second terminal and start the backend with `PUBLIC_ORIGIN=http://localhost:5173`; Vite proxies `/api` to port 3000. Generated local data lives in the ignored `lnbits-nrm/data/` folder. Run one manager per data directory.

The visual style and CSS were copied from the original Aedos dashboard reference into this application's `web/` directory. The logo uses the LNbits lightning bolt in theme-matched black and white SVG assets. strfry is fetched at the pinned upstream commit during the Docker build, together with its corresponding dependency commits. Its MIT license is copied from that same upstream checkout into the image at `/app/licenses/strfry.txt`; dependency licenses remain with their packages.
