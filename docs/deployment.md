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
docker compose up -d
```

This pulls the pre-built images from GHCR and starts the stack. To build from source instead, uncomment the `build:` blocks in your `compose.yml` and run `docker compose up -d --build`.

The default stack runs `db` (PostgreSQL) plus the **combined app image** (`ghcr.io/printstreamapp/printstream`) run in two roles — `api` (default) and `bridge` (the bundled LAN agent, the same image with a `bridge` command) — and a `slicer` (`ghcr.io/printstreamapp/printstream-slicer`). The `api` service is the **single web-facing container**: its image embeds the built web SPA and, via `SERVE_WEB_DIR`, serves it together with `/api` and the `/ws` fan-out on one port (published as `:8080` by default). There is no separate nginx container. To run the API alone behind your own web tier instead — a CDN or an existing static host (the "split" topology) — set `SERVE_WEB_DIR=` (empty) on the `api` service; the same image then serves only `/api` + `/ws`. Persistent data lives in two named volumes: `printstream-postgres-data` for PostgreSQL and `printstream-data` for API-managed assets.

On first start the API auto-creates a default workspace when the database has no workspaces yet.

### Slicer service

The `slicer` service is part of the stack and binds to loopback by default (`127.0.0.1:4010` on the deployment host). Keep `SLICER_BIND_HOST=127.0.0.1` unless you intentionally need direct network access. Set `SLICER_SERVICE_URL` (and a `SLICER_SERVICE_TOKEN` secret) on the API to enable server-side slicing.

**Architecture:** the combined app image (`printstream`, used by the `api` and `bridge` roles) is published multi-arch for `linux/amd64` and `linux/arm64`, so it runs natively on x86 servers and on arm64 boards like a Raspberry Pi. The `slicer` image is **amd64-only** because it bundles the x86 Bambu Studio CLI; there is no arm64 build. On an arm64 host, run the stack without the slicer — `docker compose up -d --scale slicer=0`, or remove the `slicer` service from `compose.yml` for a permanent change — and leave `SLICER_SERVICE_URL` unset; server-side slicing is unavailable there, but printing, the library, and live status all work.

## How printers connect (the bridge)

PrintStream reaches your printers through a bridge: an outbound client that lives on the same LAN as the printers, discovers them automatically, and talks to them over MQTT/FTPS/camera. It publishes no inbound ports and only connects out to your server over `BRIDGE_SERVER_URL`.

### Bundled bridge (default)

A single-host install runs a bundled `bridge` service for you (with its own `printstream-bridge-data` volume for bridge state plus bridge-local library/dispatch files) in **managed-bridge mode** (`MANAGED_BRIDGE=true`): one workspace, one server-owned bridge that pairs itself on first start, and the Bridges settings page stays hidden because there is nothing for you to manage. There is no secret to set — the API generates a provisioning token at `MANAGED_BRIDGE_TOKEN_FILE` on the shared `printstream-provision` volume, and the bundled bridge reads it from the same path to authenticate its one-time pairing. Because that token lives in a private file rather than on the network, this is safe regardless of how the API is exposed.

Set `MANAGED_BRIDGE=false` to turn this off: the bundled bridge then waits to be paired by hand and the Bridges settings page reappears (the connect-code flow below). That's the mode to use when you want more than one bridge, or a bridge on another machine.

> SSDP auto-discovery needs LAN multicast, which the default Docker bridge network does not forward. If the bundled bridge does not discover printers, switch the `bridge` service to `network_mode: host` and point `BRIDGE_SERVER_URL` at a host-reachable API address — or add printers by host/serial/access-code instead. The provisioning token is unaffected; it travels over the shared volume, not the network.

## Reverse proxy

A reverse proxy is optional now that the `api` service serves the app directly — point your browser at the published port and you are done. For TLS, a custom domain, or fronting the stack at the edge, put a proxy in front; it has a single upstream (the `api` service) for `/`, `/api`, and `/ws`. The host-level config used in front of the app stack is intentionally kept server-local as `nginx.conf` and ignored by git; a tracked reference version lives at `nginx.conf.example` — copy or adapt that file. Library uploads use chunked requests so large 3MF/G-code files can pass through request-size-limited proxies such as Cloudflare; keep the proxy body-size limit aligned with the API's upload ceiling for non-library upload routes and any direct-to-origin use.

If you front the stack with any reverse proxy (nginx, Caddy, Traefik, Cloudflare Tunnel, ...) set `TRUST_PROXY` on the api container so `req.ip` and `req.protocol` reflect the real client. `1` means "a single proxy hop"; you can also pass an integer or a comma-separated IP/CIDR list.
