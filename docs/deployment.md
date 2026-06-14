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

## How printers connect (the bridge)

PrintStream reaches your printers through a bridge: an outbound client that lives on the same LAN as the printers, discovers them automatically, and talks to them over MQTT/FTPS/camera. It publishes no inbound ports and only connects out to your server over `BRIDGE_SERVER_URL`.

### Bundled bridge (default)

A single-host install runs a bundled `bridge` service for you (with its own `printstream-bridge-data` volume for bridge state plus bridge-local library/dispatch files) in **managed-bridge mode** (`MANAGED_BRIDGE=true`): one workspace, one server-owned bridge that pairs itself on first start, and the Bridges settings page stays hidden because there is nothing for you to manage. There is no secret to set — the API generates a provisioning token at `MANAGED_BRIDGE_TOKEN_FILE` on the shared `printstream-provision` volume, and the bundled bridge reads it from the same path to authenticate its one-time pairing. Because that token lives in a private file rather than on the network, this is safe regardless of how the API is exposed.

Set `MANAGED_BRIDGE=false` to turn this off: the bundled bridge then waits to be paired by hand and the Bridges settings page reappears (the connect-code flow below). That's the mode to use when you want more than one bridge, or a bridge on another machine.

> SSDP auto-discovery needs LAN multicast, which the default Docker bridge network does not forward. If the bundled bridge does not discover printers, switch the `bridge` service to `network_mode: host` and point `BRIDGE_SERVER_URL` at a host-reachable API address — or add printers by host/serial/access-code instead. The provisioning token is unaffected; it travels over the shared volume, not the network.

### Bridge on a separate machine (advanced)

If your printers are on a different network than the server, run the bridge near the printers instead of using the bundled one. Set `MANAGED_BRIDGE=false` so the server keeps manual pairing, disable the bundled bridge (run the stack with `--scale bridge=0`, or delete the `bridge` service from your `compose.yml`), then, on the printer-side machine:

```bash
cp .env.bridge.example .env
docker compose -f compose.bridge.example.yml up -d --build
```

Point `BRIDGE_SERVER_URL` at your server's API origin. The standalone bridge example defaults to `network_mode: host` so LAN SSDP discovery works out of the box on Linux hosts. Pair it from Settings → Bridges using the connect code it logs on first start.

## Reverse proxy

The host-level reverse proxy config used in front of the app stack is intentionally kept server-local as `nginx.conf` and ignored by git. A tracked reference version lives at `nginx.conf.example`; copy or adapt that file when setting up an external nginx proxy for `/`, `/api`, and `/ws`. Library uploads use chunked requests so large 3MF/G-code files can pass through request-size-limited proxies such as Cloudflare; keep the nginx body-size limit aligned with the API's upload ceiling for non-library upload routes and any direct-to-origin use.

If you front the stack with any reverse proxy (nginx, Caddy, Traefik, Cloudflare Tunnel, ...) set `TRUST_PROXY` on the api container so `req.ip` and `req.protocol` reflect the real client. `1` means "a single proxy hop"; you can also pass an integer or a comma-separated IP/CIDR list.
