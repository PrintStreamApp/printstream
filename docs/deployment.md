# Deployment

How to run PrintStream in production. The short version lives in the
[README](../README.md); this is the full reference. Configuration variables are
documented in [docs/configuration.md](configuration.md).

## Docker Compose (recommended)

Copy the tracked env template first, then edit the resulting workspace-local
`.env` for the host you are actually deploying:

```bash
cp .env.server.example .env
```

Copy the tracked stack template first, then edit the resulting workspace-local
`compose.yml` for the host you are actually deploying:

```bash
cp compose.server.example.yml compose.yml
```

```bash
docker compose up -d --build
```

The default stack runs three core services: `db` (PostgreSQL), `api` (Node + Prisma + WS/control-plane server), and `web` (multi-stage SPA build served by `nginxinc/nginx-unprivileged`). The web image is the public surface and listens on `:8080`; nginx reverse-proxies `/api` and `/ws` to the `api` service. Persistent data lives in two named volumes: `printstream-postgres-data` for PostgreSQL and `printstream-data` for API-managed assets.

On first start the API auto-creates a default workspace when the database has no workspaces yet (`AUTO_CREATE_DEFAULT_WORKSPACE`, `DEFAULT_WORKSPACE_SLUG`, `DEFAULT_WORKSPACE_NAME`).

### Slicer service

The `slicer` service is part of the stack and binds to loopback by default (`127.0.0.1:4010` on the deployment host). Keep `SLICER_BIND_HOST=127.0.0.1` unless you intentionally need direct network access. Set `SLICER_SERVICE_URL` (and a `SLICER_SERVICE_TOKEN` secret) on the API to enable server-side slicing.

## Running the bridge

The bridge is the piece that lives on the same LAN as your printers. It is an outbound client — it publishes no inbound ports and only talks to your PrintStream server over `BRIDGE_SERVER_URL`.

**On the same host as the stack** (printers reachable from that LAN), enable the opt-in Compose profile:

```bash
docker compose --profile bridge up -d --build
```

That adds the `bridge` service with its own `printstream-bridge-data` volume for bridge state plus bridge-local library/dispatch files.

**On a separate machine near the printers**, use the standalone example file:

```bash
cp .env.bridge.example .env
docker compose -f compose.bridge.example.yml up -d --build
```

The standalone bridge example defaults to `network_mode: host` so LAN SSDP printer discovery works out of the box on Linux hosts; set `BRIDGE_SERVER_URL` to the public API origin the bridge should register with.

## Reverse proxy

The host-level reverse proxy config used in front of the app stack is intentionally kept server-local as `nginx.conf` and ignored by git. A tracked reference version lives at `nginx.conf.example`; copy or adapt that file when setting up an external nginx proxy for `/`, `/api`, and `/ws`. Library uploads use chunked requests so large 3MF/G-code files can pass through request-size-limited proxies such as Cloudflare; keep the nginx body-size limit aligned with the API's upload ceiling for non-library upload routes and any direct-to-origin use.

If you front the stack with any reverse proxy (nginx, Caddy, Traefik, Cloudflare Tunnel, ...) set `TRUST_PROXY` on the api container so `req.ip` and `req.protocol` reflect the real client. `1` means "a single proxy hop"; you can also pass an integer or a comma-separated IP/CIDR list.

## SSH deploy helper

For SSH-based deployments from a checkout, prefer the deploy helper:

```bash
npm run deploy:prod:ssh
```

It validates locally, verifies that local `HEAD` matches `origin/main`, SSHes to the target configured by `DEPLOY_SSH_HOST`, updates the checkout at `DEPLOY_REPO_PATH`, runs `docker compose up --build -d` from the server-local `compose.yml`, then tails the API logs. Set `DEPLOY_SSH_HOST` and `DEPLOY_REPO_PATH` in your shell environment or the workspace-root `.env` before running it. Useful flags:

- `--push` to push local `HEAD` before deploying
- `--dry-run` to print the exact SSH command and remote plan without changing anything
- `--skip-validate` to skip local `npm run validate`
- `--host`, `--port`, `--repo-path`, and `--branch` to override the defaults

Deployment env vars:

- `DEPLOY_SSH_HOST` required unless `--host` is provided
- `DEPLOY_REPO_PATH` required unless `--repo-path` is provided
- `DEPLOY_SSH_PORT`, `DEPLOY_GIT_BRANCH`, and `DEPLOY_SSH_KEY` are optional overrides

## Publishing bridge updates

Connected bridges can self-update from signed app-bundle releases served by the API (see [docs/bridge-update-system.md](bridge-update-system.md)).

To publish a bridge app-bundle update into the API release directory, set `BRIDGE_UPDATE_PRIVATE_KEY` or `BRIDGE_UPDATE_PRIVATE_KEY_FILE`, then run:

```bash
npm run package:update-bundle:api --workspace @printstream/bridge -- --api-base-url https://your-printstream-origin
```

The `Bridge Packages` GitHub Actions workflow also emits a `bridge-update-bundle` artifact for tagged releases when `BRIDGE_UPDATE_PRIVATE_KEY` is configured as a repository secret and `BRIDGE_UPDATE_API_BASE_URL` is configured as a repository variable.

When deploying a tagged commit over SSH, bridge update assets are promoted automatically: the remote host downloads `bridge-<version>.zip` and `bridge-<version>.release.json` from the matching GitHub release into the API `BRIDGE_RELEASES_DIR` before Compose restarts. Pass `--no-promote-bridge-releases` or set `DEPLOY_PROMOTE_BRIDGE_RELEASES=false` to opt out. For local/manual artifacts, pass `--sync-bridge-releases` or set `DEPLOY_SYNC_BRIDGE_RELEASES=true` to sync `data/bridge-releases` to the remote API data directory before Compose restarts.
