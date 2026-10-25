# Security and relay reliability review

## Final pre-repository audit — 2026-10-25

**Conclusion:** the application fixes and rebuilt image pass the checks below. The source is suitable to put into a repository, but the image does **not** have a clean vulnerability scan. Use `AI_MODERATION_ENABLED=false` for the initial deployment; enabling untrusted video processing remains a security concern. Rehearse migration on a separate consistent database copy before replacing the existing relay. No production container or database was changed.

Reviewed image: `sha256:58cacfcf61efe10044074333edb11caf30567a9db24992f5c93a505e0ec686f4`, locally tagged `lnbits-nrm:security-audit` and `lnbits-nrm:local`. This section supersedes older image IDs and scan statements below. Earlier performance measurements are historical, not a capacity guarantee for this image.

### Fixes made

- Management HTTP requests now have a 30-second overall request timeout, 15-second header/inactivity limits and a shorter keep-alive timeout. Previously incomplete requests could stay open without an overall request deadline. A real socket regression test verifies that an incomplete login upload is disconnected without creating a session.
- Shutdown now rejects new mutating API requests after body parsing, and the relay maintenance/removal methods also check shutdown state. Previously new deletion or policy work could start while shutdown was draining existing jobs. Reads remain available during graceful shutdown.
- The Docker build and runtime now use Debian 13 (Trixie) and Node 24.22.1 in the tested build. This updates OS/media dependencies while retaining the exact unmodified upstream strfry commit `4cd3cf64850caf47dda46c2a2abbbf3525a64d10`. Unused global npm/Yarn tooling and its separate dependency trees are removed from the final image. Runtime remains UID/GID 1000 with Compose capabilities dropped and no-new-privileges enabled.

### Review and validation

The source review covered signed one-use admin challenges, session expiry/cookies, origin checks, request limits, settings validation, SQL/subprocess use, static serving, public relay metadata, independent policy enforcement, shutdown/deletion, filesystem permissions, AI disabling, media URL validation and provider responses. No authentication bypass was found in the inspected paths. This is a local code review and regression audit, not an independent penetration test or a guarantee against unknown vulnerabilities.

- **82 unit tests passed**, including five new security tests covering shutdown, cross-origin mutations, prototype poisoning, forwarded-address spoofing, expired sessions, static traversal/security headers and slow uploads.
- The Docker build passed Svelte checks and the production frontend build.
- All five real-container integration suites passed: full API/relay/browser/media, AI-disabled deployment, host storage, public relay metadata, and reliability/recovery. Tests used disposable storage and signing keys, no live AI provider and no production data.
- The reliability run checked 1,000 concurrent publishes under one CPU/512 MiB, quota enforcement, missing-rule rejection, Activity failure, a suspended manager, reporting recovery, graceful and abrupt restarts, exact acknowledged-event preservation, LMDB counts and SQLite integrity. The short burst is regression evidence, not a production load test.
- `npm audit` reported **zero known advisories** for the locked application dependency tree, including development dependencies. This does not establish native-library safety.
- Git's actual ignore rules were used to enumerate publication candidates, followed by a private-key/token pattern check. No matches were found. Environment files, relay/manager databases, generated rules, dependencies, builds and test artifacts are excluded; `.env.example` is intentionally included. This is not a guarantee that every possible secret format is detected. There is no existing Git history to audit.

### Container vulnerability results and remaining risk

Grype 0.121.0, downloaded from its official release and checksum-verified, scanned both images with the vulnerability database built at `2026-10-25T06:27:34Z`. Counts below are **distinct advisory IDs per severity**, not demonstrated exploit paths; one FFmpeg advisory often matches nine installed packages.

| Severity | Previous Debian 12 image | Reviewed Debian 13 image |
| --- | ---: | ---: |
| Critical | 10 | 3 |
| High | 95 | 56 |
| Medium | 108 | 70 |
| Low | 27 | 12 |
| Negligible | 123 | 100 |
| Unknown | 19 | 17 |

The final scan reports no fixed-version upgrade available within its matched package feed, which **does not mean the remaining issues are safe or fixed**. Debian status and scanner severity can differ, and bundled/static native dependencies are not comprehensively covered. Rebuild with fresh base images and rescan before deployment and periodically afterward.

Triage of the three remaining critical IDs:

- [CVE-2026-75143](https://security-tracker.debian.org/tracker/CVE-2026-75143): FFmpeg RIST input overflow. NRM permits only the `file` protocol for both ffprobe and ffmpeg, excluding the described `async:rist://` path. The package remains flagged; this is a reachability mitigation, not a patch.
- [CVE-2026-52490](https://security-tracker.debian.org/tracker/CVE-2026-52490): a `tiffcrop` command-line processing bug. The runtime contains libtiff but not the `tiffcrop` program, and NRM never invokes it. The source-package match is retained in the count.
- [CVE-2026-6653](https://security-tracker.debian.org/tracker/CVE-2026-6653): libxml2 parsing use-after-free. The package remains vulnerable. NRM does not directly parse XML and excludes XML playlist demuxers, but this review does not prove every transitive path unreachable.

**Video moderation remains the principal unresolved application exposure.** For example, [CVE-2026-107678](https://security-tracker.debian.org/tracker/CVE-2026-107678) affects MP4 parsing, a format NRM accepts. Process timeouts and restricted formats reduce exposure but do not patch parsers or create an OS sandbox. ffprobe/ffmpeg share the container's CPU, memory, filesystem and user identity with the manager. Decoder crashes become review errors, but resource exhaustion or a decoder compromise could affect the relay or manager data. Other high/medium findings have not all been proven unreachable. Keep AI disabled for this deployment; broader media isolation and patched decoder packages are required before treating this path as hardened.

### Deployment conditions

Keep the management port private or behind correctly configured HTTPS, and restrict `ADMIN_NPUBS` to trusted operators. Provider credentials are protected from unauthenticated API responses but stored unencrypted in the private manager database, so protect that directory and backups. The production proxy, firewall, host, actual 29.1 GiB database and its workload were not audited.

Before cutover: take a consistent backup; test a separate copy; confirm UID/GID 1000 access and the intended bind mount; set `REQUIRE_EXISTING_DB=true`; start with retention `0`, AI disabled and both publish limits `0` if unrestricted parity is intended; preserve the old image/config/backup; never run two deployments against the same relay database. Existing saved settings take precedence over fresh defaults. The review performed no production shutdown, ownership changes or migration.

---

## Public policy metadata follow-up

NRM now appends a public policy summary to the configured NIP-11 description. It covers retention and rolling cleanup, author exceptions without identities, minute/hour limits, access restrictions, word filtering and asynchronous AI. It does not expose list entries, provider configuration or credentials. Saved-policy changes update upstream strfry configuration atomically; description changes also reload when the plugin stays enabled. No publishing-path code was changed.

Build `sha256:8c164284a3dc3aaf6c845ec06ddc1c28dfdcbe6faa07f6e516511ec08ac11589` passed 72 unit tests, Svelte checks and the frontend build. A disposable real-strfry test verified initial metadata, live retention/rate/AI edits, escaping of the base description, private-list redaction, plugin bypass and successful publishing on the same WebSocket after all updates. No existing relay container was restarted by this change. The broader wrapper validation below describes the preceding build.

## Current implementation: independent wrapper

The wrapper refactor supersedes the synchronous policy and batching designs described in the historical sections below. The Docker image compiles the pinned upstream strfry commit unchanged. The custom source patch, native socket bridge and manager policy server have been removed. No production database was accessed and the new image was not deployed to the existing relay.

Publishing decisions run in an independent, persistent standard strfry plugin. Author sets, compiled word filters, retention overrides and bounded per-author rate counters are held in memory. Rules are atomically published to a private JSON file; the plugin checks for changes on each request. Missing or invalid rules reject writes. The plugin does not call the manager or SQLite to decide. When all filtering, rate limits, finite retention and AI are off, strfry's plugin path is empty. Defaults remain 60/minute and 1,000/hour; saved settings are preserved.

Background Activity/AI collection has bounded buffers and cannot block on a manager acknowledgement. SQLite remains FULL-synchronous for background transactions, settings, saved review jobs and authentication. There is deliberately **no durability guarantee before acceptance for Activity or AI collection**. Overload, a full 10,000-event review queue, process crashes or broken reporting connections can leave accepted events unreviewed. Known overflow/storage warnings appear in the UI; not every lost report is detectable. Queued reviews survive restart. Rate counters reset when the plugin restarts and are local to one relay writer; active counters are not evicted to admit extra authors when the 100,000-author/hour memory limit is reached.

Native strfry metrics are polled in the background, including in bypass mode. Detailed Activity/decision graphs are available only while the plugin is enabled. AI alone keeps the plugin enabled to supply review candidates, including private event kinds without weakening read authentication. AI review/removal still happens after strfry stores an event, and optional author bans update the saved rules. Retention and clear-all use the existing strfry command interface.

### Measurements

Final built image: `sha256:57dfa87da291532dab56ec278cad0ac5d9b246c2012eec1c6e6b7709fc1268e0` (`lnbits-nrm:wrapper` and `lnbits-nrm:local`). Measurements used `sha256:90c92d400ffc0ee3a3c6f927a6701e8540bdabbc27586f1684a89f52aa785e6f`; subsequent changes added a socket test and corrected UI save wording, with identical relay/policy/reporting runtime code. Each run used a disposable empty database, one CPU, 512 MiB memory/no swap, 16 connections, 10,000 pre-signed notes after 500 warm-up notes, and 1 KiB note content. AI and quotas were off.

| Mode | Publishes/second | Median ACK | p95 ACK | Memory after load |
| --- | ---: | ---: | ---: | ---: |
| Bare, bypass comparison | 4,874.9 | 2.0 ms | 4.6 ms | 10.43 MiB |
| NRM, plugin bypassed | 4,931.1 | 2.0 ms | 4.3 ms | 53.22 MiB |
| Bare, filter comparison | 5,254.2 | 1.9 ms | 3.8 ms | 9.926 MiB |
| NRM, independent word filter | 3,255.8 | 2.8 ms | 19.7 ms | 96.61 MiB |

The bypass result is effectively parity within the variation of this small test, not evidence that NRM makes strfry faster. Filtering still has material saturation overhead: about 38% lower throughput in this comparison, plus a larger p95 under shared one-CPU load. JSON/pipe processing and background reporting still consume CPU and disk even though publishing no longer waits for their persistence. These results do not establish production capacity with the existing 29.1 GiB database, readers, AI or njump. Memory figures are post-load snapshots, not peaks.

### Validation and remaining limits

69 unit tests pass, including real independent-plugin execution with no manager/database, atomic rule reload and corrupt-rule rejection, in-memory quota ordering and bounds, background rollback/recovery and saturation, socket frame bounds/fragmented UTF-8, native metrics and the existing authentication/moderation/storage tests. Svelte checks report no errors or warnings.

Both real-relay performance/reliability runs passed: Activity storage failures leave publishing and filtering working; suspending only the manager with SIGSTOP leaves the plugin accepting permitted notes and rejecting banned words; missing rule files reject; recovery restores reporting; quotas cannot overshoot; native graphs collect; graceful/abrupt restarts preserve every acknowledged event; LMDB metadata counts and SQLite integrity agree. Early harness runs needed two test-only corrections: excluding tini from manager PID discovery and using Node to send signals because the slim image has no standalone `kill` command.

Full relay/browser integration, AI-disabled deployment/browser integration, and host-storage Compose integration all passed against the final image. These cover real signing/authentication, all rules, asynchronous AI removal and bans, allow-list authority, clear cancellation, provider errors, restart/crash recovery, ffmpeg/media cleanup, all three charts and ranges, keyboard inspection, both themes, mobile layout, AI activation denial, existing-file guards, permissions and persistent host mounts. Earlier browser attempts exposed a wrong browser environment variable and a stale assertion expecting two charts instead of three; both test setup issues were corrected before the successful run.

A stalled management event loop no longer gates publishing, but the manager still supervises the bundled relay: supervisor/container exit stops the service. Health reports relay responsiveness and known rule-application failures, not proof of the next database write or a complete plugin health check. Reporting faults are shown separately and do not make a functioning relay unhealthy. Enabling/bypassing a plugin relies on normal upstream configuration reload and can take a few seconds. On-disk rule update failures leave the last applied policy in effect and are retried/reported.

The migration requirements remain: test a separate consistent copy of the real database, retain the old image/config/backup, verify UID/GID 1000 access, preserve metadata/URLs/proxy settings, start with retention zero and AI off, explicitly disable both quotas for unrestricted parity, and never overlap deployments on the production database. This refactor is not a production migration or a new independent security audit. The earlier dependency scan did not cover OS packages or unknown vulnerabilities.

---

The remaining sections are historical records. Their synchronous-policy behavior and image tags do not describe the current wrapper.

## Historical implementation: durable batching

The original 495-events/second result below is historical. The optimized build is `sha256:0490ebce8069cd62d94ff705ecfe72cca0290a943641bca227b7d84ffccb8458`, available locally as `lnbits-nrm:local`; the previous image is retained as `lnbits-nrm:before-performance`. No running service was recreated.

Changes: bounded batch requests through a small patch to the pinned strfry writer/plugin protocol; a native pipe-to-Unix-socket bridge replacing the extra Node/HTTP forwarding process; cached SQLite statements; one policy snapshot and cumulative-counter update per batch; and one FULL-synchronization transaction per batch. Individual Activity records, strict ordered quotas, AI queue durability and fail-closed behavior remain. No LMDB schema/storage changes and no asynchronous Activity mode were introduced.

Final measurements used the same one-CPU/512-MiB/no-swap limits, 16 persistent connections, AI and quotas off, and 1 KiB note content:

| Test | Bare strfry events/s | Optimized NRM events/s | Bare median ACK | NRM median ACK |
| --- | ---: | ---: | ---: | ---: |
| Original-size test: 1,000 notes, no warm-up | 5,881.4 | 3,213.1 | 1.9 ms | 4.7 ms |
| Longer test: 10,000 notes after 500 warm-up notes; NRM tested first | 4,703.1 | 3,418.6 | 2.2 ms | 4.4 ms |

NRM's original-size result improved approximately 6.5-fold from 494.8 to 3,213.1 events/second. In the longer comparison, throughput was still about 27% below bare strfry. An earlier long run in the opposite order measured 3,369.1 versus 4,921.6 events/second. These measurements support a substantial improvement, **not negligible overhead at saturation**. They remain small local tests, not production capacity guarantees. The final long-run post-load memory snapshots were 57.68 MiB for NRM and 9.309 MiB for bare strfry, not peak memory measurements.

Profiling in a separate disposable run attributed roughly 88–90% of policy-evaluation time to SQLite commits. A 200-microsecond collection delay was tested and removed because it made performance worse. The retained implementation only batches events already collected by strfry and does not deliberately delay collection. Background Activity persistence could reduce the remaining synchronization cost when neither AI queueing nor quotas requires a durable write, but would change crash-loss behavior for recent Activity/counters. That change is pending an operator preference and is **not enabled**.

Validation: 69 unit tests; successful full relay/browser, AI-disabled and host-storage integration suites; and repeated real-relay reliability runs. New cases verify batch-wide rollback, FULL synchronization, strict quotas without overshoot, fragmented UTF-8 socket frames, oversized-frame rejection, recovery on the same connection after storage failure, rejection of deliberately wrong batch result IDs, exact stored event IDs across graceful/abrupt restarts, and SQLite integrity. One full-suite run concurrent with other suites hit a mock background-review timeout; the isolated rerun passed without a runtime change. The timeout's cause was not established, so the run is not presented as proof that all timing conditions are covered. Large benchmark scans initially exceeded the harness output cap; the bounded cap was increased to cover its documented maximum event count.

The migration prerequisites and limitations below still apply. The production relay/database have not been migrated or load-tested.

## Original review

Reviewed on 2026-10-25 before migrating the existing nostr.com relay. The review covered application code, Docker configuration, authentication, publishing policy, background moderation, destructive maintenance, storage, and failure recovery. Production was not accessed or changed. Tests used disposable containers, volumes and host directories.

**Conclusion:** the fixes below passed local validation. Proceed to a rehearsal on a separate copy of the existing database; this review does not establish that the production migration is safe without that rehearsal. Publishing performance is a material limitation, even with AI disabled.

## Fixed during the review

- **Database counting:** the dashboard previously ran a full event-count scan every minute. It now reads the event table's LMDB metadata with `mdb_stat`, using bounded output and a five-second timeout. The count is cached for a minute. The real database count was checked against a full scan in the disposable test.
- **Publishing consistency and disk writes:** quota changes, the optional AI queue entry, the activity record and cumulative counters now share one SQLite transaction. A failed write rolls back the whole decision. Traffic is counted only after commit. Durable SQLite synchronization remains enabled.
- **Maintenance failures:** failure to persist a job cannot leave the busy flag stuck. Final status-write failures are surfaced without stranding maintenance. Scheduled cleanup errors are caught. Shutdown prevents a clear-all operation from restarting strfry, handles already signaled children, and closes SQLite even if traffic flushing fails.
- **Failure visibility:** detected policy failures appear in the dashboard and health endpoint. A successful policy decision clears the warning. Logs report transitions without logging event payloads or secrets.
- **Bounded activity storage:** activity is pruned every 100 decisions, retaining at most 10,099 between batches. Cumulative totals remain. Expired quota windows are removed at their actual boundary. SQLite may retain previously allocated free pages.
- **Authentication abuse:** cheap challenge, author and event checks precede signature verification. Authentication bodies are limited to 8 KiB. The per-minute client-address map has a real size cap and no longer scans every entry on every request.
- **Health endpoint load:** simultaneous relay probes coalesce and share a short cache.
- **Video parsing:** ffprobe/ffmpeg accept only the intended container demuxers, retain the local-file protocol restriction, and cap individual allocations. A disguised playlist referencing another local file is rejected; normal MP4 sampling still works. This is parser hardening, not a separate OS sandbox or a total memory bound.

## Validation

The final image was built successfully, including Svelte checks, 63 unit tests and the production frontend build. The following integration suites passed against real strfry:

- Full API, relay and browser suite: signed login, access lists, words, quotas, retention, asynchronous AI, bans, clear-all, persistence, restart/crash recovery, media processing, charts and storage UI.
- AI-disabled deployment: saved moderation is overridden, API activation attempts fail, no AI review occurs, other policy controls continue working.
- Host storage: missing-database guards, ownership/access checks, original-file preservation and notes/settings surviving Compose down/up.
- Reliability: 16 concurrent publishing connections, injected SQLite write failure, rejection without policy bypass, continued reads, recovery, graceful restart, abrupt container stop, exact stored event IDs, metadata counts and SQLite `integrity_check` returning `ok`.

`npm audit` and `npm audit --omit=dev` reported zero known advisories for the installed dependency tree (82 production dependencies). This does not cover Debian packages, ffmpeg, the strfry binary or unknown vulnerabilities; no dedicated container/OS CVE scan was performed. The review found no authentication bypass in the inspected paths, but is not an independent penetration test.

The reproducible commands are documented in README. Build tested: `lnbits-nrm:local`, image ID `sha256:252a21182c05cd1daddafc32c959ac86eab1e97b5b3959d8a073adf1f77db554`.

## Original publishing measurements

A single successful local burst test used the same pinned strfry binary in each container: one CPU, 512 MiB memory, no swap, a fresh database, 1,000 pre-signed notes with 1 KiB content and 16 persistent connections. NRM used AI off, quotas off and empty word/access lists. All notes were accepted and subsequently verified in storage.

| Measurement | Bare strfry | LNbits NRM |
| --- | ---: | ---: |
| Events/second over this burst | 6,174.5 | 494.8 |
| Median acknowledgement latency | 2.0 ms | 29.5 ms |
| 95th percentile latency | 4.3 ms | 49.3 ms |
| Post-load Docker memory snapshot | 7.852 MiB | 83.52 MiB |

These are short synthetic measurements, not a production capacity guarantee or peak memory measurements. They do not model the 29.1 GiB database, reader traffic, enabled policies, AI, or the server's other containers. Earlier harness runs encountered a publish timeout and Docker port reassignment after restart; the final harness uses bounded longer deadlines and refreshes mapped ports. Do not infer a reliable saturation limit from this one successful run. The local policy round trip and durable SQLite writes impose substantial overhead relative to bare strfry.

## Limits that matter before migration

1. **Test the real database copy.** The reported old binary is strfry 1.1.0. Both its [database version declaration](https://raw.githubusercontent.com/hoytech/strfry/1.1.0/src/constants.h) and the [pinned target declaration](https://raw.githubusercontent.com/hoytech/strfry/4cd3cf64850caf47dda46c2a2abbbf3525a64d10/src/constants.h) specify database version 3. That supports expected compatibility but does not validate the actual files, fork/build differences or every protocol behavior. The generated config uses the pinned binary's defaults for options not explicitly set, including reader limits and NIP-42 behavior.
2. **Keep a consistent rollback copy.** Stop the old relay for the final backup of its entire database directory and configuration. Keep the original image. Do not run both deployments against the same directory during cutover. The production files are root-owned; UID/GID 1000 needs access. Setup deliberately refuses to rewrite existing ownership. Test permissions on the copy first.
3. **Preserve policy parity.** Start with fresh manager state, retention `0`, no retention overrides, empty author/word lists and `AI_MODERATION_ENABLED=false`. Saved manager settings can retain destructive policies. New installations default to 60/minute and 1,000/hour per author; use zero for both if the replacement should retain unrestricted publishing. Set `REQUIRE_EXISTING_DB=true` and verify the intended mount, public metadata, URLs and proxy routing.
4. **Check actual workload headroom.** The server also runs njump. A small empty-database test does not establish that one CPU and 1 GB can support its production traffic with this manager. Test representative reads and writes on the copy, and monitor latency, rejections, memory and disk before committing to cutover.
5. **Policy availability affects publishing.** Local policy/storage errors intentionally reject new writes. The relay can continue serving reads during a policy-only failure, as tested; a manager/container crash can stop the whole service. Compose restarts an exited container, but does not restart it merely because Docker marks it unhealthy. Health reports known failures and relay responsiveness, not proof that the next database write will succeed. Long-running maintenance may exceed the bounded shutdown window and be recorded as interrupted on restart.
6. **Keep management private or behind HTTPS.** Sessions use signed, one-use admin challenges, HttpOnly/SameSite cookies and exact-origin checks. Configure the exact HTTPS origin and WSS relay URL. The UI defaults to localhost. Authentication address limits may be shared by clients behind the same reverse proxy. No host firewall, production proxy or public endpoint was examined.
7. **AI remains an additional resource and data-sharing cost when enabled.** It is asynchronous but shares the container's CPU/memory and can fill its bounded review queue. Provider failures follow the chosen keep/remove policy; the default is removal. The AI-disabled deployment avoids this path. Protect the manager database and backups: provider keys are stored there unencrypted against host access.

No production shutdown, permission change, backup, migration or deployment was performed by this review.
