# Deployment and migration

[Back to setup](../README.md) · [Policy reference](reference.md) · [Security review](../SECURITY_REVIEW.md)

The application folder, package, and image use `lnbits-nrm`. The short product name is **LNbits NRM** and the full name is **LNbits Nostr Relay Manager**. The connected Aedos oracle is a separate service and retains its name.

The base `compose.yaml` retains the `aedos` service key and `aedos_data` volume key so existing named-volume deployments upgrade in place with `docker compose up --build -d`. Existing `.env` files are not rewritten; without the host override, storage remains in the existing named volume. Keep using the same Compose project name and data volume when upgrading. Existing `/data/aedos.sqlite` databases (including their WAL files) are reopened in place; new installations use `/data/lnbits-nrm.sqlite`. Existing session cookies and theme preferences remain supported.

### Host-directory storage

New installations use the optional `compose.host.yaml` override selected in the example `.env`. Both paths are configurable:

| Variable | Default host path | Container path |
| --- | --- | --- |
| `NRM_DATA_DIR` | `./data` | `/data` (settings, sessions, traffic history, generated configuration) |
| `STRFRY_DB_DIR` | `./strfry-db` | `/data/strfry-db` (relay database) |

Keep the two host directories separate. The regular application refuses missing host directories; `docker compose run --rm -T setup </dev/null` creates them deliberately. Setup runs once as root with limited capabilities, then checks access as UID/GID 1000. It changes ownership and permissions only on empty directories and never changes existing database files. The relay and UI continue to run unprivileged.

For example, to attach an existing dockurr/strfry database, use:

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

Environment variables are listed in [.env.example](../.env.example). `RELAY_NAME`, `RELAY_DESCRIPTION`, `RELAY_PUBKEY`, and `RELAY_CONTACT` populate the relay's NIP-11 metadata. `RELAY_PUBKEY` accepts an npub or hexadecimal public key, publishes it as hexadecimal, and defaults to the first admin key when omitted. It does not grant management access. `RELAY_CONTACT` is an optional public address such as `mailto:operator@example.com`. Operator public keys are boot configuration, separate from the publishing allow list; being an operator does not bypass relay policy.

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

## Build and configuration changes

The Dockerfile downloads and compiles the pinned upstream strfry commit without source patches. No local strfry clone or Git submodule is needed. Builds need GitHub and package-registry access; the running image does not need GitHub. Change `STRFRY_COMMIT` deliberately and run the integration checks before upgrading the relay version.

After editing `.env`, recreate the container with `docker compose up -d --no-build aedos`. A plain restart does not apply changed environment variables. Recreation briefly restarts both the UI and relay. Multiple `ADMIN_NPUBS` values are comma-separated public keys, and every listed operator has full management access.

The setup helper uses `-T` to avoid terminal allocation and `</dev/null` to avoid consuming subsequent commands from a pasted shell script. For scripted `docker compose exec` calls that do not need input, use those options too.

## HTTPS with Caddy

For a shared relay/UI hostname, set these values in `.env` (replace the example hostname):

```env
PUBLIC_ORIGIN=https://relay.example.com
RELAY_URL=wss://relay.example.com
UI_BIND=127.0.0.1
UI_PORT=3100
RELAY_BIND=127.0.0.1
RELAY_PORT=7777
```

Port 3100 is the host UI port; the UI still listens on port 3000 inside the container. Pick a free host port without changing other applications. Use this site block in Caddy:

```caddyfile
relay.example.com {
    @relaySocket {
        path /
        expression `header({'Upgrade': 'websocket'}) || header({':protocol': 'websocket'})`
    }
    @relayInfo {
        path /
        header Accept *application/nostr+json*
    }
    @relayPreflight {
        path /
        method OPTIONS
    }
    handle @relaySocket {
        reverse_proxy 127.0.0.1:7777
    }
    handle @relayInfo {
        reverse_proxy 127.0.0.1:7777
    }
    handle @relayPreflight {
        reverse_proxy 127.0.0.1:7777
    }
    handle {
        reverse_proxy 127.0.0.1:3100
    }
}
```

Browser requests go to NRM; WebSockets, NIP-11 metadata and root preflight requests go to strfry. Caddy's [handle blocks](https://caddyserver.com/docs/caddyfile/directives/handle) select one matching route. For a host-installed Caddy managed by systemd, validate first, and reload only after NRM is healthy on the configured ports:

```bash
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy
```

Check `https://relay.example.com/api/health`, fetch the root with `Accept: application/nostr+json`, and verify a real WebSocket connection and admin sign-in. A separate UI hostname also works: proxy that host to the UI port, leave the relay hostname pointing at strfry, and set `PUBLIC_ORIGIN` to the UI hostname.
