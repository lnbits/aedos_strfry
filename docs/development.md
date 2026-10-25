# Development and validation

[Back to setup](../README.md)

Run repository-level Docker commands from the repository root and npm commands from `lnbits-nrm/`.

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

Run `npm run test:integration:reliability` for concurrent publishing under one-CPU/512-MiB limits, comparison with the same bare strfry binary, plugin bypass or independent filtering, in-memory quotas, missing-rule rejection, Activity-storage fault injection, continued enforcement while the manager is suspended, native metrics, restart/crash recovery, and database/count verification. `NRM_TEST_EVENTS=10000 NRM_TEST_WARMUP=500` selects a longer warmed-up run; `NRM_TEST_FILTER=1` enables a word filter for comparison; `NRM_TEST_CONNECTIONS` defaults to 16, `NRM_TEST_MANAGED_FIRST=1` reverses test order, and `NRM_TEST_IMAGE` selects another image. Its databases and containers are disposable. See [the security and reliability review](../SECURITY_REVIEW.md) for findings, results and migration limits.

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
