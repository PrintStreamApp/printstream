# printstream

A mobile-friendly PWA for monitoring and controlling Bambu Lab printers on your LAN, with a workspace model that scales from a single self-hosted install to a hosted multi-tenant deployment.

> Smaller, simpler, and more touch-friendly than Bambuddy. Self-hosted, plugin-extensible, and designed to be usable from a phone first.

The shared library now keeps version history when a file is overwritten, so older revisions can be downloaded, printed, or restored from the file history dialog instead of being lost.

## Stack

- **Backend:** Node.js + Express + Prisma (PostgreSQL) + MQTT + WebSockets
- **Frontend:** Vite + React + Joy UI + TanStack Query, installable as a PWA
- **Shared:** TypeScript Zod contracts and compatibility helpers in `packages/shared`
- **Plugins:** First-class plugin system on both the API and the web client (see `ARCHITECTURE.md`)

## Workspaces

The app now has two workspace modes:

- **Platform workspace:** the host-level admin surface for platform Admin authentication, tenant provisioning, platform plugin policy, and platform-wide logs.
- **Tenant workspace:** the operational surface for a specific customer or internal workspace, including printers, library, jobs, notifications, tenant-local auth, and tenant logs.

Fresh installs auto-create a default workspace on first API start (`AUTO_CREATE_DEFAULT_WORKSPACE`, `DEFAULT_WORKSPACE_SLUG`, `DEFAULT_WORKSPACE_NAME`). Tenant workspaces live under `/workspaces/<slug>`, the default tenant landing route is `/workspaces/<slug>/printers`, tenant stats live at `/workspaces/<slug>/stats`, the workspace chooser lives at `/workspaces`, and the platform workspace lives at `/platform`.
In the open-source build the root route goes straight into the app. The hosted deployment layers a public marketing homepage (plus `/terms`, `/privacy`, `/contact`) and platform tenant administration on top via private modules — see `docs/open-core.md`.

## Layout

```
apps/
  api/        Express + MQTT + WS + Prisma + plugin host
  web/        Vite + React + Joy UI PWA + plugin host
packages/
  shared/     Zod contracts shared between api and web
.github/      Copilot customization (instructions + prompts)
CLAUDE.md     Claude Code project instructions (mirrored into nested CLAUDE.md files)
.claude/      Claude Code customization (guides + slash commands)
.devcontainer/  VS Code dev container
```

## Quick start (devcontainer)

1. Open the repo in VS Code with the **Dev Containers** extension installed.
2. "Reopen in Container". The devcontainer starts a `db` Postgres service, installs dependencies, and applies the checked-in Prisma migrations.
3. From a terminal inside the container:

```bash
cp .env.cloud.example .env
npm run dev
```

This starts the shared TypeScript watcher, the API on port 4000, the bridge runtime, and the Vite dev server on port 5173. Visit http://localhost:5173.

The bridge dev default points at `http://api:4000`, which is the right target when the bridge runs in Docker on the same network as the API container. If you run the bridge watcher directly in the devcontainer or on your host instead of Docker, override `BRIDGE_CLOUD_URL` in `.env` to `http://localhost:4000`.

To run the public demo tenant locally without pairing a real bridge, use:

```bash
npm run dev:demo
```

That command bootstraps the `demo` tenant, attaches the seeded demo printers to the dedicated demo bridge runtime, writes `data/demo-bridge-state.json`, creates a dedicated `data/demo-library` folder for simulator print files, and starts `npm run dev:demo --workspace @printstream/bridge`. Open http://localhost:5173/demo or http://localhost:5173/workspaces/demo/printers to view the demo workspace.

To run the normal real bridge and the public demo simulator bridge side by side, use:

```bash
npm run dev:demo:parallel
```

The real bridge uses your normal `.env` bridge settings and state file. The simulator bridge always uses `data/demo-bridge-state.json`, `data/demo-library`, and the reserved `demo` tenant, so it will not overwrite the real bridge identity or reuse the real bridge library files.

In Docker deployments the demo bridge builds the `demo-runtime` target from the bridge Dockerfile. The default production bridge target starts the real bridge launcher and does not include the demo entrypoint files. Public bridge images install only the bridge runtime production workspace dependencies and do not copy API or web app directories into the runtime layer.

Drop demo-only `.gcode.3mf` files into `data/demo-library` when you want the simulator bridge storage browser and seeded demo prints to use them.

The checked-in devcontainer installs `ffmpeg`, which the API uses to proxy chamber cameras on RTSP-based X/X2/H-series printers during development.
It also installs `wine`, `nsis`, `xorriso`, and `squashfs-tools` so the bridge workspace can produce Linux-hosted Windows portable or NSIS packages plus AppImage-based Linux packages from inside the devcontainer once you rebuild or reopen the container.

The devcontainer Compose stack includes a standalone slicer service on port `4010`, but it is now opt-in rather than auto-started. Start it manually with `docker compose up -d slicer` when you want to use the bundled local worker. The slicer image downloads the latest stable BambuStudio AppImage from `bambulab/BambuStudio` during Docker build unless you provide an explicit override. During the image build, PrintStream also generates BambuStudio's `machine_full`, `process_full`, and `filament_full` preset caches from the bundled profile JSONs so CLI slicing has the same default preset data normally prepared during UI setup. The default CLI argument template is `--slice {plate} --debug 2 --outputdir {outputDir} --min-save --export-3mf {outputFileName} {input}`.

Use `BAMBUSTUDIO_APPIMAGE_URL` only when you want to pin a specific AppImage URL instead of using GitHub's latest stable release. Use `BAMBUSTUDIO_APPIMAGE_ASSET_REGEX` if the upstream release contains multiple AppImage assets and you need to force a particular filename pattern.

`SLICER_SERVICE_URL` comes from your local env file rather than the devcontainer definition. If you want to use the bundled slicer instead of a remote worker, start it with `docker compose up -d slicer` and point your local env at `http://slicer:4010`. To verify the sidecar after starting it, run:

```bash
curl http://slicer:4010/health
```

Then run `npm run dev`, upload an unsliced `.3mf` project to the library, and use the file action menu's `Slice` command. The slicer runs BambuStudio under isolated `HOME` and XDG config/cache directories inside the slicer work volume so first-run state does not use the container user's default home. The exact `SLICER_CLI_ARGS_TEMPLATE` must match the CLI flags supported by the BambuStudio build you install; PrintStream substitutes `{input}`, `{output}`, `{outputDir}`, `{outputFileName}`, 1-based `{plate}`, `{plateZeroBased}`, `{homeDir}`, `{configDir}`, `{cacheDir}`, and `{dataDir}`.

If you want local development to use the deploy server's slicer instead of the local sidecar, set `SLICER_SERVICE_URL=http://127.0.0.1:4010` in your local `.env` and run:

```bash
npm run dev:deploy-slicer
```

That helper opens an SSH tunnel to the deploy host using `DEPLOY_SSH_HOST`, `DEPLOY_SSH_PORT`, and `DEPLOY_SSH_KEY` from `.env`, forwards local port `4010` to the remote slicer loopback port, forces the local API to use the tunneled `SLICER_SERVICE_URL`, and tears the tunnel down again when the dev command exits. If your local `.env` does not define `SLICER_SERVICE_TOKEN`, the helper reads the token from the deploy host's repo `.env` over SSH before it starts the API.

The default CLI template includes `--export-json` so the slicer generates metadata (estimated print time, filament weight, filament cost) which the web UI displays in the slicing progress toast and final result. The metadata comes from the JSON export file generated during slicing.

BambuStudio CLI logs all diagnostics through stdout/stderr, and some successful slices include upstream `warning` or `error` lines such as missing system preset JSON files or invalid tool-change commands found while analyzing generated G-code. Treat the PrintStream job status and the presence of a saved `.gcode.3mf` artifact as authoritative; the slicer only fails the job when the CLI exits non-zero or no output artifact is produced.

## Quick start (host machine)

```bash
cp .env.cloud.example .env
docker compose up -d db
npm install
npm run db:generate
npm run db:migrate:deploy
npm run dev
```

If you are not using the repo's Compose-managed Postgres service, point the workspace-root `.env` at your own PostgreSQL instance before running the Prisma commands.

`npm run dev` starts the bridge runtime too. The `.env.cloud.example` bridge default uses `http://api:4000` so a bridge running in Docker can reach the API by service name on the same Compose network. If you are running the bridge watcher directly on your host instead of Docker, override `BRIDGE_CLOUD_URL=http://localhost:4000` in `.env`.

`npm run dev` now waits for the local database and applies checked-in Prisma migrations before it starts the API and web watchers. If the database cannot consume the checked-in migration history as-is yet, startup falls back to `db push` and baselines the current checked-in migrations so future deploys can return to normal `migrate deploy` behavior.

That fallback is a compatibility bridge, not a substitute for real migrations. If a feature needs a new table or column, add and commit a real Prisma migration before considering the change complete.

For local schema work, prefer `npm run db:migrate -- <name>` so Prisma records a real migration in `apps/api/prisma/migrations/`.

If you add H2D-, H2S-, or P2S-class printers and active Skip Objects matters to you, enable Bambu Studio's Store Sent Files on External Storage option when the printer supports it. Internal-only active jobs on those newer platforms may not expose the metadata that PrintStream needs to load the skippable object list.

To clear local auth identities, roles, sessions, service accounts, and auth-provider setup state while preserving tenants, printers, library files, jobs, and other app data, run `npm run db:reset-auth`. The script reseeds built-in platform roles and each existing tenant's built-in roles after the reset.

To capture real printer camera media for demos, use the workspace-level helper:

```bash
npm run capture:printer-media -- --printer Home --snapshot-count 8 --snapshot-interval-sec 180 --clip-sec 20 --output-dir data/demo-captures/home-h2d-$(date +%Y%m%d-%H%M%S)
```

The command reads the target printer from Prisma, saves timestamped JPEG snapshots, and optionally records a short MP4 clip from the live chamber stream. It uses the current `DATABASE_URL`, so once your local database points at the populated dev database no extra overrides are needed.

If you refresh the branded web assets, keep `apps/web/public/icon.svg` as the default icon source, `apps/web/public/maskable-icon.svg` as the Android launcher-safe source, and regenerate the derived PNG install assets with:

```bash
npm run web:icons:export
```

## Testing

```bash
npm run test
```

This runs the repo's TypeScript test suite via Node's built-in test runner. `npm run validate` now includes linting, tests, typechecking, and Prisma schema validation, so new features should add or update focused regression tests before they are considered complete.

The aggregate test runner runs the whole suite in one `node --test` pass (each file is isolated in its own subprocess) and never stops at the first failure. It caps how many files run at once so a busy/shared CPU does not make timing-sensitive suites flake; the default is about half the cores. Tune it with `npm run test -- --concurrency=<n>` or `NODE_TEST_CONCURRENCY=<n> npm run test` (lower it if you see flakes; that knob also bounds peak memory). Pass a path substring to scope the run, e.g. `npm run test -- print-job-recorder`.

When a run fails, the runner re-runs only the failing files one at a time to pinpoint them and to separate genuine failures from load-induced flakes (a file that fails under the full run but passes alone). It exits non-zero only for reproducible failures.

The aggregate test runner uses Node's compact `dot` reporter by default to keep successful runs readable. Use `npm run test -- --reporter=spec` when you need per-test names while debugging a failure.

TODO: add a lightweight React/browser interaction harness for mobile-friendly component tests, especially dialog footer wrapping, tap-target behavior inside clickable cards, and other UI interactions that pure state/unit tests do not cover.

## Production (Docker Compose)

Copy the tracked cloud env template first, then edit the resulting
workspace-local `.env` for the host you are actually deploying:

```bash
cp .env.cloud.example .env
```

Copy the tracked cloud stack template first, then edit the resulting
workspace-local `compose.yml` for the host you are actually deploying:

```bash
cp compose.cloud.example.yml compose.yml
```

```bash
docker compose up -d --build
```

The default stack runs five services: `db` (PostgreSQL), `api` (Node + Prisma + WS/control-plane server), `demo-bootstrap` (one-shot demo tenant/bootstrap job), `demo-bridge` (simulator bridge for the public demo tenant), and `web` (multi-stage SPA build served by `nginxinc/nginx-unprivileged`). The web image is the public surface and listens on `:8080`; nginx reverse-proxies `/api` and `/ws` to the `api` service. Persistent data lives in two named volumes: `printstream-postgres-data` for PostgreSQL and `printstream-data` for API-managed assets, including the public demo bridge state and demo library directory.

The `slicer` service is part of the cloud stack and now binds to loopback by default (`127.0.0.1:4010` on the deployment host). Keep `SLICER_BIND_HOST=127.0.0.1` unless you intentionally need direct network access.

If you want your local dev API to use the deploy-server slicer instead of the devcontainer sidecar, create an SSH tunnel and point local API env at it, or use `npm run dev:deploy-slicer` to do both together:

```bash
ssh -N -L 4010:127.0.0.1:4010 <deploy-user>@<deploy-host>
```

Then in local `.env` set:

```bash
SLICER_SERVICE_URL=http://127.0.0.1:4010
SLICER_SERVICE_TOKEN=<same token as deploy server>
```

Restart local API after updating env.

`demo-bootstrap` creates or refreshes the reserved `demo` tenant, registers the simulator bridge, and writes the bridge runtime state file before `demo-bridge` starts. It does not copy curated demo print files into the volume for you. To populate the hosted demo library, place your seed `.gcode.3mf` files in `PUBLIC_DEMO_BRIDGE_LIBRARY_DIR` inside `printstream-data` before or after deployment; the bootstrap step and the API reconciler will surface those files in the demo workspace.

The printer-local `bridge` container is available as an opt-in Compose profile rather than starting by default:

```bash
docker compose --profile bridge up -d --build
```

That adds the `bridge` service to the same stack, with its own `printstream-bridge-data` volume for bridge state plus bridge-local library/dispatch files.

If you want to run only the bridge on end-user hardware, use the standalone example file instead:

```bash
cp .env.bridge.example .env
docker compose -f compose.bridge.example.yml up -d --build
```

The bridge does not publish any inbound ports. It is an outbound client that talks to the cloud/API origin over `BRIDGE_CLOUD_URL`. The standalone bridge example defaults to `network_mode: host` so LAN SSDP discovery works out of the box on Linux hosts; set `BRIDGE_CLOUD_URL` to the public API origin the bridge should register with.

## Desktop bridge packages

For non-Docker bridge installs, the `@printstream/bridge` workspace now includes an Electron tray wrapper around the existing bridge runtime.

- The tray menu shows the current bridge status, the assigned bridge ID, and the active connect code when the bridge is waiting to be paired.
- The tray menu includes one-click actions to copy the bridge ID or connect code and to open the local config and library folders.
- The packaged app stores its bridge state and bridge-local library files under the OS user-data directory instead of the Docker-oriented `/data/...` defaults.

The desktop wrapper creates a `bridge-desktop.json` file on first launch in its user-data bridge folder. The default `cloudUrl` is `http://localhost:4000`, which is correct when the API is running locally outside Docker. If the bridge should connect to a hosted PrintStream deployment, edit that file and change `cloudUrl` before pairing.

Inspect what the current host can build with:

```bash
npm run package:plan --workspace @printstream/bridge
```

Or inspect a specific target architecture explicitly:

```bash
npm run package:plan:arm64 --workspace @printstream/bridge
npm run package:plan:x64 --workspace @printstream/bridge
```

Build whatever the current host supports with:

```bash
npm run package:host --workspace @printstream/bridge
```

Or build the host-supported targets for a specific architecture:

```bash
npm run package:host:arm64 --workspace @printstream/bridge
npm run package:host:x64 --workspace @printstream/bridge
```

Or build every target that the current host can support in one go:

```bash
npm run package:all-supported --workspace @printstream/bridge
```

Explicit per-platform commands are still available when the host satisfies their prerequisites:

```bash
npm run package:linux:all --workspace @printstream/bridge
npm run package:win:all --workspace @printstream/bridge
npm run package:appimage --workspace @printstream/bridge
npm run package:appimage:arm64 --workspace @printstream/bridge
npm run package:appimage:x64 --workspace @printstream/bridge
npm run package:linux --workspace @printstream/bridge
npm run package:linux:arm64 --workspace @printstream/bridge
npm run package:linux:x64 --workspace @printstream/bridge
npm run package:mac --workspace @printstream/bridge
npm run package:win --workspace @printstream/bridge
npm run package:win:arm64 --workspace @printstream/bridge
npm run package:win:x64 --workspace @printstream/bridge
```

For a fast packaging smoke test that creates an unpacked app directory on the current host instead of an installer, use:

```bash
npm run package:desktop:dir --workspace @printstream/bridge
```

macOS packages still need to be built and signed on macOS, and Windows installers are best built on Windows CI or a Windows host. Linux packages can be produced directly on Linux.

In the current devcontainer/Linux environment, the bridge packaging wrapper now supports both `arm64` and `x64` output selection for Linux and Windows targets. The default `package:linux` and `package:win` commands still build for the current host architecture, while the `:arm64` and `:x64` variants request those architectures explicitly. `package:linux:all` and `package:win:all` run the respective packaging passes for both supported architectures in one command. AppImage builds are exposed directly through the `package:appimage*` commands and require `xorriso` plus `mksquashfs` from `squashfs-tools`. macOS packages still require a macOS host.

Tagged releases can build the bridge package matrix automatically in GitHub Actions. The workflow produces Linux (`arm64`, `x64`) and Windows (`arm64`, `x64`) bridge artifacts, uploads them as workflow artifacts, and attaches them to the tag release when the workflow runs from a tag push.

For SSH-based deployments, prefer the deploy helper:

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

The host-level reverse proxy config used in front of the app stack is intentionally kept server-local as `nginx.conf` and ignored by git. A tracked reference version lives at `nginx.conf.example`; copy or adapt that file when setting up an external nginx proxy for `/`, `/api`, and `/ws`. The cloud app stack follows the same pattern: the tracked template is `compose.cloud.example.yml`, while the real deployment copy lives at `compose.yml` and stays out of git. Library uploads use chunked requests so large 3MF/G-code files can pass through request-size-limited proxies such as Cloudflare, and the upload UI shows both browser-to-server and server-to-bridge progress; keep the nginx/body-size limit aligned with the API's upload ceiling for non-library upload routes and any direct-to-origin use.

If you front this with another reverse proxy (nginx, Caddy, Traefik, Cloudflare Tunnel, ...) set `TRUST_PROXY` on the api container so `req.ip` and `req.protocol` reflect the real client. `1` means "a single proxy hop"; you can also pass an integer or a comma-separated IP/CIDR list.

## Configuration

See `.env.dev.example` in the workspace root for local development, `.env.cloud.example` for the app/cloud stack, and `.env.bridge.example` for a bridge-only host. Those files intentionally list only the vars a typical install sets; every other key has a working default and can simply be added to your workspace-root `.env` to override. This table is the complete, overridable reference:

| Variable | Default | Description |
|---|---|---|
| `API_PORT` | `4000` | API HTTP port. |
| `NODE_ENV` | `development` | Runtime mode (`development` / `production` / `test`). The Compose stacks set `production`. |
| `DATABASE_URL` | `postgresql://postgres:postgres@db:5432/printstream?schema=public` | Prisma PostgreSQL URL. The default expects the repo's Compose/devcontainer `db` service; use `localhost` or another host only if you run Postgres outside Compose. |
| `DB_WAIT_TIMEOUT_MS` | `60000` | Max time `npm run dev:db` waits for Postgres to accept connections before failing. |
| `DB_WAIT_RETRY_MS` | `1000` | Poll interval `npm run dev:db` uses while waiting for Postgres. |
| `CLIENT_ORIGIN` | `http://localhost:5173` | Comma-separated list of allowed browser origins. For the hosted app use `https://printstream.app`. |
| `BRIDGE_CLOUD_URL` | `http://api:4000` | Bridge control-plane URL. The default expects the bridge to reach the API over the same Docker network by service name; override to `http://localhost:4000` when the bridge runs outside Docker. |
| `BRIDGE_LIBRARY_DIR` | `./data/bridge-library` | Bridge-local directory for library-owned files and dispatch replicas. |
| `BRIDGE_NAME` | `PrintStream Bridge` | Human-readable name used when the bridge registers and is connected to a workspace. |
| `BRIDGE_SIMULATOR_STATUS_INTERVAL_MS` | `10000` | Status tick interval used by the dedicated demo bridge runtime. |
| `BRIDGE_STATE_FILE` | `./data/bridge-state.json` | Path where the bridge persists its connected identity and runtime token. |
| `BRIDGE_UPDATE_CHANNEL` | `stable` | Release channel used for bridge update checks. |
| `BRIDGE_AUTO_UPDATE` | `false` | When true, the bridge installs an available compatible app-bundle update after registration and restarts through the launcher. |
| `BRIDGE_RELEASES_DIR` | `./data/releases` | Bridge-container directory for staged and activated app-bundle releases. |
| `BRIDGE_RELEASE_RETENTION_DAYS` | `7` | How long to keep rollback releases after the active release has confirmed healthy. |
| `BRIDGE_UPDATE_PUBLIC_KEY` | official PrintStream key | Optional Ed25519 public key override for verifying signed app-bundle updates. Normal public bridge installs should leave this unset. Compose `.env` files may use a one-line PEM with `\n` escapes when overriding. |
| API `BRIDGE_RELEASES_DIR` | `./data/bridge-releases` | API-container directory containing signed bridge release JSON fragments and zip assets served to bridges. |

To publish a bridge app-bundle update into the API release directory, set `BRIDGE_UPDATE_PRIVATE_KEY` or `BRIDGE_UPDATE_PRIVATE_KEY_FILE`, then run:

```bash
npm run package:update-bundle:api --workspace @printstream/bridge -- --api-base-url https://printstream.app
```

The `Bridge Packages` GitHub Actions workflow also emits a `bridge-update-bundle` artifact for tagged releases when `BRIDGE_UPDATE_PRIVATE_KEY` is configured as a repository secret and `BRIDGE_UPDATE_API_BASE_URL` is configured as a repository variable.

When deploying a tagged commit over SSH, bridge update assets are promoted automatically: the remote host downloads `bridge-<version>.zip` and `bridge-<version>.release.json` from the matching GitHub release into API `BRIDGE_RELEASES_DIR` before Compose restarts. Pass `--no-promote-bridge-releases` or set `DEPLOY_PROMOTE_BRIDGE_RELEASES=false` to opt out. For local/manual artifacts, pass `--sync-bridge-releases` or set `DEPLOY_SYNC_BRIDGE_RELEASES=true` to sync `data/bridge-releases` to the remote API data directory before Compose restarts.
| `PUBLIC_DEMO_BRIDGE_NAME` | `PrintStream Demo Bridge` | Name assigned by the public-demo bootstrap script to the simulator bridge. |
| `PUBLIC_DEMO_BRIDGE_LIBRARY_DIR` | `./data/demo-library` | Dedicated library directory created by the public-demo bootstrap script for simulator-only print files. |
| `PUBLIC_DEMO_BRIDGE_STATE_FILE` | `./data/demo-bridge-state.json` | State file written by the public-demo bootstrap script for the simulator bridge. Keep this separate from the real bridge `BRIDGE_STATE_FILE`. |
| `PUBLIC_DEMO_BRIDGE_RUNTIME_TOKEN` | *(dev default only)* | Runtime credential written into the demo bridge state file by the bootstrap script. Set this explicitly for public deployments. |
| `CLOUDFLARE_EMAIL_ACCOUNT_ID` | *(unset)* | Cloudflare account ID for Email Sending. Required for local-auth one-time email codes outside demo mode and public beta signup delivery. |
| `CLOUDFLARE_EMAIL_API_TOKEN` | *(unset)* | Cloudflare API token with Email Sending permission. Treat this as a secret and rotate it if exposed. |
| `CLOUDFLARE_EMAIL_FROM_EMAIL` | *(unset)* | Verified sender address for Cloudflare Email Sending, for example `noreply@mail.printstream.app`. |
| `CLOUDFLARE_EMAIL_FROM_NAME` | *(unset)* | From display name for Cloudflare Email Sending. |
| `BETA_SIGNUP_TO_EMAIL` | `contact@printstream.app` | Recipient for public beta signup requests. |
| `AUTH_LOCAL_EMAIL_CODE_TTL_MINUTES` | `15` | Expiry window for local-auth one-time email codes. |
| `LIBRARY_DIR` | `./data/library` | Directory where uploaded `.3mf`/`.gcode`/`.stl` files are stored. |
| `LIBRARY_MAX_UPLOAD_BYTES` | `1073741824` | Maximum accepted library upload size in bytes (default 1 GiB). |
| `LIBRARY_TRANSIENT_RETENTION_DAYS` | `7` | How long hidden transient library uploads are retained before scheduled cleanup removes them. |
| `LIBRARY_RECYCLE_RETENTION_DAYS` | `30` | How long recycle-bin (soft-deleted) library files stay restorable before scheduled cleanup removes them permanently. |
| `LIBRARY_UNREFERENCED_SLICE_RETENTION_HOURS` | `24` | How long unreferenced sliced outputs (never saved to the library or snapshotted for print history) are kept before cleanup removes them. |
| `SLICER_SERVICE_URL` | *(unset)* | Optional URL for the standalone slicer container. Set to enable server-side slicing orchestration. |
| `SLICER_SERVICE_TOKEN` | *(unset)* | Optional bearer token shared between the API and slicer container. Treat this as a secret. |
| `SLICER_BIND_HOST` | `127.0.0.1` | Host interface for published deploy slicer port in Compose (`127.0.0.1` keeps it private to the server). |
| `SLICER_BIND_PORT` | `4010` | Host port mapped to slicer container port `4010` in Compose. |
| `SLICING_MAX_CONCURRENT_JOBS` | `1` | Maximum number of slicing jobs the API will run against slicer workers at once. |
| `SLICING_MAX_QUEUED_JOBS` | `10` | Maximum number of queued slicing jobs waiting for a concurrency slot. |
| `SLICING_REQUEST_TIMEOUT_MS` | `1800000` | Timeout for API-to-slicer requests. |
| `SLICER_DEFAULT_TARGET_ID` | *(first installed target)* | Override the default slicer version shown in the slice dialog. Must match an `id` from the built-in target manifest (`/opt/printstream-slicers/targets.json`). |
| `SLICER_ENABLE_PIPE_PROGRESS` | `true` | When `true`, append Bambu/Orca CLI `--pipe` progress JSON frames into slicing job output so the UI can render determinate progress updates. |
| `SLICER_BAMBUSTUDIO_HOME_DIR` | under slicer work dir | Isolated home directory used when launching BambuStudio. Subdirectories are created per target id. |
| `SLICER_BAMBUSTUDIO_DATA_DIR` | under slicer work dir | Persistent `--datadir` used for slicer presets and first-run state. Subdirectories are created per target id. |
| `PRINT_JOB_THUMBNAIL_RETENTION_DAYS` | `90` | How long completed-job thumbnail PNGs and persisted final-frame snapshot JPGs are retained before scheduled cleanup removes them. |
| `PLUGINS_DIR` | `./data/plugins` | Directory for installed external plugins. |
| `TRUST_PROXY` | *(unset)* | Express `trust proxy` setting; set when behind a reverse proxy. |
| `TENANT_DOMAIN_SUFFIX` | *(unset)* | Tenant-routing suffix for cloud installs; e.g. with `printstream.app`, requests to `acme.printstream.app` resolve to the `acme` tenant. |
| `DEFAULT_TENANT_SLUG` | *(unset)* | Optional demo-data tenant slug hint. Anonymous requests no longer fall back to a tenant automatically. |
| `DISCOVERY_PORT` | `2021` | UDP port the bridge uses for SSDP printer auto-discovery. |
| `PUBLIC_BASE_URL` | *(unset)* | Absolute URL used for notification media embeds (e.g. camera snapshots). |
| `MQTT_DEBUG_LOGS` | `false` | Set to `true` or `1` to log raw MQTT publish/receive traffic for protocol debugging. |
| `CAMERA_DEBUG_LOGS` | `false` | Set to `true` or `1` to re-enable verbose RTSP camera readiness logs such as `snapshot ready` and `first frame`. |
| `NTFY_TOPIC_URL` | *(unset)* | Default ntfy topic for the notifications-ntfy plugin. |
| `VITE_API_BASE_URL` | *(unset)* | Build-time API base URL for the web app (leave blank in dev to use the Vite proxy). |
| `VITE_DOMAIN_MIGRATION_TARGET` | *(unset)* | Temporary old-domain-only setting that builds a self-destroying service worker and redirects every page load to the new origin. |

## Features

- **Printer dashboard:** Live status cards with camera/cover thumbnails, temperatures, fans, speed, progress, ETA, layer progress, per-nozzle readouts, AMS units, AMS settings/drying controls, external spools, optional door/duct state chips, and HMS error monitoring. AMS / external spool labels use material-aware Bambu color names when possible and can render Bambu multi-color palettes instead of a single flat swatch.
- **Authentication:** Optional built-in auth providers for local passkeys + one-time email codes and generic OAuth/OIDC SSO, backed by reusable roles, permissions, service accounts, browser-session management, and self-service account security flows. Human accounts now use one global `AuthUser` per email plus tenant-scoped `AuthTenantMembership` rows, so the same operator can move between multiple tenant workspaces without duplicate identities. Provider enablement and setup still stay scoped to the current workspace, so platform auth and tenant auth can diverge cleanly, and when sign-in is required the auth UI renders in place at the requested route instead of forcing a dedicated auth route.
- **Controls:** Pause/resume/stop, per-light controls (including dual chamber lights where supported), model-specific printer settings such as AI monitoring and air management, AMS slot rescans, external spool load/unload + editing, calibration, named pressure-advance profile selection/creation for AMS presets, skip objects with multi-select plate previews that prefer embedded BambuStudio pick masks and fall back to parsed first-layer geometry, and force status refresh.
- **Multi-printer:** Bulk actions, state filters, configurable cards-per-row, drag-to-reorder.
- **Auto-discovery:** Bridge-owned SSDP printer discovery on the LAN, plus add-printer validation that runs through the selected bridge and warns when the bridge cannot reach local MQTT or the printer rejects LAN mode.
- **Camera:** Live stream and shared snapshot relay for both TLS camera models (P1/A1 family) and RTSP-based models (X/X2/H family), with API-side coalescing so multiple web clients do not multiply printer camera connections. RTSP streams use ffmpeg passthrough sync so ffmpeg does not synthesize duplicate MJPEG frames, and the retained bridge-runtime source frame limiter is disabled by default. Snapshot refresh is server-owned and client-aware: the API keeps a fast 3-second snapshot loop running while visible web clients are actually watching a printer tile, and falls back to a slow ~20-second background loop (staggered across printers) for every online camera-capable printer when nobody is watching, so returning users see a recent frame instead of a stale one. Bridge-local TLS camera reads pause while printer FTPS/storage work is active; RTSP camera reads do not share that transport lock.
- **Print dispatch:** Queue prints from the library to one or multiple printers with tray mapping, plate selection, printer-model / plate-type / nozzle-size compatibility checks, model-gated print options, upload progress, bounded FTPS retry, and manual retry for failed dispatches. Multi-plate `.gcode.3mf` dispatch keeps the selected plate identity in the printer-visible filename / job name so printer-side history is not ambiguous. Per-printer serialized FTPS upload.
- **Orders:** Built-in production-order workflow for reusable templates, tracked required prints, per-plate completion, confirm/manual completion actions, and order detail routing in the web app. Templates accept direct-printable gcode files and plain project 3MFs; starting an unsliced-3MF order item runs the slice-then-print flow and dispatches the sliced output against the order.
- **Library:** Upload 3MF/gcode/STL files, folder hierarchy, embedded printer / plate / nozzle metadata chips, plate browsing for multi-plate 3MFs, thumbnail extraction, re-print, batch selection for move/delete, and background delete jobs with progress toasts that keep running after the dialog closes. Uploads accept whole folder structures (directory picker or drag-and-drop of mixed files and folders) and replicate the tree as library folders; upload progress lives in a toast-backed queue that self-paces under the API rate limit and keeps running after navigating away. Deleting files moves them to a recycle bin (with undo) where they can be restored, permanently deleted, or emptied in bulk; entries auto-expire after a retention window. Folders can be deleted with their contents after confirmation (contents go to the recycle bin). Version history shows who added/replaced/restored each version and restore provenance, and old versions can be downloaded, printed, or sliced without restoring them. 3MF rows show a plate-count chip in list mode.
- **Server-side slicing:** Optional standalone slicer container that hosts multiple BambuStudio and OrcaSlicer versions side by side. Users pick the slicer version in the slice dialog, choose a real printer or manual profile settings, and generated direct-printable artifacts flow back into the normal library and dispatch path. Workspace admins can upload custom BambuStudio printer, quality, and material presets from Settings > Slicing using either raw JSON presets or BambuStudio preset bundle exports, and those tenant-scoped presets appear in the slice dialog alongside built-in and 3MF project profiles. The container installs the last three releases of each slicer family and exposes them all through a single manifest-backed target registry.
- **Jobs and stats:** In-progress jobs combine queued dispatches, upload progress, and active prints in one section, followed by chronological print history and production stats from the same persistent print-job lifecycle. PrintStream-dispatched prints now create a durable unfinished job row before the printer reports `job.started`, externally-started prints still appear when first discovered from printer status, offline printers keep the last known active job visible until status resumes, and restored terminal status moves stale unfinished rows into history with reprint shortcuts, calibration history/replay, durable dispatched-file snapshots, and history media that can show both the plate cover and a persisted final camera frame on printer cards and the dedicated Jobs page. Tenant, printer, and platform stats persist print counts, successful/wasted hours, and resolved filament usage without rescanning history on every page load.
- **Platform administration:** Dedicated platform overview with all-tenant or own-workspace stats, tenant directory, platform authentication, platform plugin policy, and platform logs.
- **Settings:** Tenant settings focus on workspace-local plugins, notifications, authentication access management, and tenant logs.
- **Printer detail:** Dedicated per-printer route that expands a single printer card with that printer's lifetime stats and job history below it.
- **Cover caching:** Active-print covers are cached on the server, can be re-identified from live job metadata, and reuse local dispatched 3MFs when the print originated in PrintStream so the API does not round-trip the same artifact back from printer storage.
- **Printer storage:** Browse, preview, download, rename, batch-delete, inspect 3MF metadata, print printer-side model files, and browse/download timelapses on the printer's SD card. Printer-storage delete progress is server-owned like print dispatch, so deletes keep running after dialogs close. Metadata, thumbnails, and active-object previews now prefer partial FTPS reads of printer-side 3MF archives instead of downloading the whole file when the archive layout allows it, and skip-object previews use embedded `Metadata/pick_N.png` masks when available.
- **Active skip-object limits:** Active-print object loading is most reliable when the active job's metadata or 3MF archive is exposed over printer storage, including many jobs written to external storage. PrintStream does not currently implement Bambu Studio's proprietary H2D-class internal-job tunnel path, so some newer H2D/H2S/P2S firmware builds may not expose skip-object data for prints stored only on internal storage. Even when the job is accessible on printer storage, externally started prints can still require printer-reported path and filename heuristics unless the printer exposes a direct `Metadata/...` path or the print originated in PrintStream.
- **Notifications:** Customizable notification templates with camera snapshot attachments. Finished-job notifications can reuse the persisted job-owned final frame instead of capturing a second ad-hoc image. Three built-in channels: browser (Web Push), Discord webhook, ntfy.
- **Firmware updates:** Check firmware release notes against Bambu's published feeds, pick a specific version when needed, upload updates over LAN to the printer SD card, cancel in-flight transfers, and track pending installs from the web UI. Installed-version checks now self-correct after printer reconnects and live status changes so stale Update chips clear without a manual reload.
- **Plate clearing:** Optional gate that blocks the next print until the user confirms the plate is clear.
- **Home Assistant bridge:** Optional built-in bridge plugin plus a companion custom integration/cards package under `integrations/home-assistant/` that exposes printers and AMS units as Home Assistant devices/entities, registers printer/AMS control services, and ships actionable Lovelace cards.
- **3D preview & editor:** Three.js preview for STL files plus plated 3MF and G-code files (per-plate thumbnails, a modal preview flow from library actions, and a G-code stats panel with per-feature time breakdown), and a multi-plate 3D editor — "Edit in 3D" from the slice dialog and "New 3D project" from the library — to import/arrange models (incl. footprint-aware auto-arrange, auto-orient, and multi-select), add primitives, split objects into parts and assemble them back, add/remove materials, add and edit negative parts, modifiers, and support blocker/enforcer volumes, paint supports/seam/colours with Bambu-style tools (circle/sphere brushes, smart/bucket fill, height range, edge detection, on-overhangs-only), place manual brim ears, schedule per-layer filament changes, and save (or Save As) a 3MF to a chosen library location.
- **Logs:** Structured log table with search, sorting, pagination, and explicit entry-kind filters. Platform logs are audit-first and mix in system diagnostics when needed; tenant logs stay scoped to the active tenant workspace.

## Print safeguards

- Direct printing is intentionally limited to `.gcode` and `.gcode.3mf` files. Plain `.3mf` projects stay browsable for inspection and metadata, but they are not dispatched directly.
- The public demo runs as the reserved `demo` tenant plus the simulator bridge. Use `npm run dev:demo` locally; it bootstraps seeded demo printers/library/jobs, starts the simulator bridge, and exposes the demo at `/demo` without changing the root route. In hosted deployments, the tracked cloud compose template also starts `demo-bootstrap` and `demo-bridge` automatically.
- Public demo settings and auth-management screens are informational only: changes are blocked server-side, curated demo library files stay read-only, and user uploads are limited to private temporary files up to 15 MB that are cleaned up within 12 hours.
- Library dispatch, reprint, and printer-storage print flows all enforce printer-model compatibility before starting a print.
- The print dialog checks plate type, nozzle diameter, and AMS tray/material compatibility before dispatch. Hard nozzle mismatches block the print; softer mismatches require an explicit user override.
- Model-specific printer settings and print-start options are only shown when the printer reports support, so unsupported models do not surface toggles they cannot honor. Nozzle offset calibration now preserves the printer-native `off` / `on` / `auto` modes, with `auto` used as the default where supported.
- Multi-plate dispatch preserves the selected plate name in the generated printer-side target name so SD-card browsing, the printer UI, and job history do not collapse several plates into the same label.
- FTPS interactions are serialized per printer and retried in a bounded way, which reduces printer-side transfer contention for dispatches, printer-storage reads, and firmware uploads.
- Firmware uploads only target versions Bambu has published, surface live transfer progress, refresh installed firmware version after reconnects or delayed version replies, and clear stale "ready to install" / "Update" state once the printer has already installed the version or the SD-card file disappears.
- The optional plate-clearing plugin can block the next print until the user confirms the build plate has been cleared.
- Destructive actions such as deleting library files, folders, and logs require confirmation.

## Plugins

The plugin system is a first-class part of the architecture. Ten built-in plugins ship today. On a fresh install they start disabled by default.

- **Platform > Settings > Plugins** manages installation, uninstall, and whether tenant-controlled plugins are available to tenant workspaces at all.
- **Tenant Settings > Plugins** lets a tenant enable or disable only the plugins that the platform has allowed for that workspace.
- **Authentication plugins** are managed from the Authentication section instead of the generic plugin manager because their state is workspace-scoped and tied to setup flow.

| Plugin | Description |
|---|---|
| `auth-local` | Passkey and one-time email-code authentication for local operators. |
| `auth-oauth` | Generic OpenID Connect authorization-code + PKCE sign-in for external identity providers. |
| `firmware-updates` | LAN firmware update checking and installation. |
| `home-assistant` | Home Assistant bridge snapshot plus setup guide for the companion custom integration and Lovelace cards, including multi-entry Home Assistant installs. |
| `orders` | Production order templates, tracked required prints, and per-print completion workflows. |
| `notifications-browser` | Web Push via VAPID + service worker. |
| `notifications-discord` | Discord webhook notifications. |
| `notifications-ntfy` | ntfy topic notifications. |
| `plate-clearing` | Print gating with plate-clear confirmation. |
| `model-previewer` | Three.js preview for STL, plated 3MF, and plated G-code files, plus a multi-plate 3D editor ("Edit in 3D" / "New 3D project") that arranges models, edits materials and support modifiers, paints supports/seam/colours, places brim ears, schedules per-layer filament changes, toggles per-object printability (BambuStudio's "Printable"), and saves new or edited 3MFs to the library. |

Third-party plugins can be uploaded and managed from the platform plugin manager. See [ARCHITECTURE.md](./ARCHITECTURE.md) and the plugin contract guide ([.github/instructions/plugins.instructions.md](./.github/instructions/plugins.instructions.md) for Copilot, [.claude/guides/plugins.md](./.claude/guides/plugins.md) for Claude Code) for the contracts.

For the current auth data model and tenant-switching flow, see [docs/auth-architecture.md](./docs/auth-architecture.md).
For active print label, cover, and skip-object resolution behavior, see [docs/active-print-resolution.md](./docs/active-print-resolution.md).

## Home Assistant bridge

Install or allow the built-in `home-assistant` plugin from Platform > Settings > Plugins, then enable it inside the target tenant workspace from Settings > Plugins before copying
`integrations/home-assistant/custom_components/printstream` into your Home Assistant config directory as
`custom_components/printstream`.

For Home Assistant installs, prefer the SSH helper:

```bash
npm run deploy:ha:ssh
```

This syncs `integrations/home-assistant/custom_components/printstream` to `custom_components/printstream` under the config path set by `HA_DEPLOY_CONFIG_PATH`, then runs the Home Assistant Docker Compose stack from `HA_DEPLOY_STACK_PATH` and restarts the configured service. Set `HA_DEPLOY_SSH_HOST`, `HA_DEPLOY_CONFIG_PATH`, and `HA_DEPLOY_STACK_PATH` in your environment before running it. Useful flags include `--dry-run`, `--service`, `--stack-path`, `--config-path`, repeatable `--compose-file`, and `--ssh-key`.

Home Assistant deploy env vars:

- `HA_DEPLOY_SSH_HOST`, `HA_DEPLOY_CONFIG_PATH`, and `HA_DEPLOY_STACK_PATH` are required unless their matching flags are provided
- `HA_DEPLOY_SERVICE`, `HA_DEPLOY_SOURCE_DIR`, `HA_DEPLOY_COMPOSE_FILES`, `HA_DEPLOY_SSH_PORT`, and `HA_DEPLOY_SSH_KEY` are optional overrides

After a Home Assistant restart:

1. Add the **PrintStream Bridge** integration.
2. Point it at your PrintStream base URL. The setup form defaults to `CLIENT_ORIGIN` from the PrintStream env when available, or `https://printstream.app` otherwise.
3. In the Home Assistant plugin panel, create the required workspace access token and paste it into the integration. The plugin keeps track of that token so it can warn you if it is later revoked or deleted. The managed token includes the printer, AMS, camera, and library access the integration needs.
4. You can add multiple **PrintStream Bridge** entries in Home Assistant, for example one per tenant workspace.
5. If Home Assistant was already configured, open the existing integration entry and use **Configure** to add or replace the token instead of deleting the entry.
6. Use the auto-registered custom cards `custom:printstream-printer-card`, `custom:printstream-ams-card`, and `custom:printstream-printer-media-card`.
7. Optional printer image entities expose the cover thumbnail and camera snapshot for use in dashboards and the bundled cards. Camera-capable printers also get a live camera entity that streams the chamber feed.
8. The integration registers PrintStream services for pause, resume, stop, refresh, chamber light control, HMS clearing, and AMS slot rescans.
9. The integration also registers a PrintStream library media source in Home Assistant's media browser.

The integration loads `/api/plugins/home-assistant/snapshot` during setup, refreshes that snapshot again after WebSocket reconnects, and otherwise stays current from live `/ws` plugin events so Home Assistant entities update without polling. The bundled custom cards use those entities for printer actions, AMS refresh/rescan shortcuts, and direct navigation from printer titles to the Home Assistant device page.

Entity exposure is model-aware. The companion integration only registers sensors and binary sensors for capabilities the current printer or AMS actually reports, including per-nozzle readouts on dual-nozzle models, AMS drying metrics on supported units, optional door / duct / light state, external spool summaries, and richer tray diagnostics.

## License

PrintStream's own source is licensed under the **PolyForm Noncommercial License 1.0.0** (see [`LICENSE`](LICENSE)). You may use, modify, and share it for any noncommercial purpose; all commercial rights are reserved. For a commercial license, contact the copyright holder. This is a source-available license, not an OSI-approved open-source license.

### Third-party software

PrintStream bundles and depends on third-party open-source software under its own separate licenses:

- **npm dependencies** — attribution and full license text for each bundled package are generated per distributable into `apps/web/public/THIRD-PARTY-NOTICES.txt` (served at `/THIRD-PARTY-NOTICES.txt` and linked from the in-app **Open source** page at `/licenses`), `apps/api/THIRD-PARTY-NOTICES.txt`, `apps/slicer/THIRD-PARTY-NOTICES.txt`, and `apps/bridge/THIRD-PARTY-NOTICES.txt`. Regenerate them with `npm run notices` after changing production dependencies. These are mostly permissive (MIT/ISC/BSD/Apache-2.0); notable weak-copyleft deps are `occt-import-js` (LGPL-2.1, bundling OpenCASCADE) and `web-push` (MPL-2.0).
- **Slicer engines** — the slicer sidecar invokes **Bambu Studio** (and optionally **OrcaSlicer**), which are licensed under **AGPL-3.0**. They are separate programs run at arm's length, so PrintStream's own code is not a derivative of them. The required attribution and corresponding-source offer are in [`apps/slicer/THIRD-PARTY-SLICERS.md`](apps/slicer/THIRD-PARTY-SLICERS.md), and that file ships inside the slicer Docker image under `/app/licenses`.
