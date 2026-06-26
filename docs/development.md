# Development

How to work on PrintStream itself. For simply running PrintStream, see the
[README](../README.md) quick start and [docs/deployment.md](deployment.md).

## Stack

- **Backend:** Node.js + Express + Prisma (PostgreSQL) + MQTT + WebSockets
- **Frontend:** Vite + React + Joy UI + TanStack Query, installable as a PWA
- **Shared:** TypeScript Zod contracts and compatibility helpers in `packages/shared`
- **Plugins:** First-class plugin system on both the API and the web client (see `ARCHITECTURE.md`)

## Repo layout

```
apps/
  api/        Express + MQTT + WS + Prisma + plugin host
  web/        Vite + React + Joy UI PWA + plugin host
  bridge/     Printer-LAN runtime (discovery, MQTT/FTPS/camera, library storage)
  slicer/     Standalone slicer worker container
packages/
  shared/         Zod contracts shared between api, bridge, and web
  bridge-runtime/ Shared LAN transport (MQTT/FTPS/camera/SSDP) used by api + bridge
  sea-runtime/    Generic single-file-executable (SEA) plumbing (service install, tray, paths)
.github/      CI workflows
.devcontainer/  VS Code dev container
```

## Quick start (devcontainer)

1. Open the repo in VS Code with the **Dev Containers** extension installed.
2. "Reopen in Container". The devcontainer starts a `db` Postgres service, installs dependencies, and applies the checked-in Prisma migrations.
3. From a terminal inside the container:

```bash
cp .env.server.example .env
npm run dev
```

This starts the shared TypeScript watcher, the API on port 4000, the bridge runtime, and the Vite dev server on port 5173. Visit http://localhost:5173.

The bridge dev default points at `http://api:4000`, which is the right target when the bridge runs in Docker on the same network as the API container. If you run the bridge watcher directly in the devcontainer or on your host instead of Docker, override `BRIDGE_SERVER_URL` in `.env` to `http://localhost:4000`.

The checked-in devcontainer installs `ffmpeg`, which the API uses to proxy chamber cameras on RTSP-based X/X2/H-series printers during development.

## Quick start (host machine)

```bash
cp .env.server.example .env
docker compose up -d db
npm install
npm run db:generate
npm run db:migrate:deploy
npm run dev
```

If you are not using the repo's Compose-managed Postgres service, point the workspace-root `.env` at your own PostgreSQL instance before running the Prisma commands.

`npm run dev` starts the bridge runtime too. The `.env.server.example` bridge default uses `http://api:4000` so a bridge running in Docker can reach the API by service name on the same Compose network. If you are running the bridge watcher directly on your host instead of Docker, override `BRIDGE_SERVER_URL=http://localhost:4000` in `.env`.

`npm run dev` waits for the local database and applies checked-in Prisma migrations before it starts the API and web watchers. If the database cannot consume the checked-in migration history as-is yet, startup falls back to `db push` and baselines the current checked-in migrations so future deploys can return to normal `migrate deploy` behavior.

That fallback is a compatibility bridge, not a substitute for real migrations. If a feature needs a new table or column, add and commit a real Prisma migration before considering the change complete.

For local schema work, prefer `npm run db:migrate -- <name>` so Prisma records a real migration in `apps/api/prisma/migrations/`.

To clear local auth identities, roles, sessions, service accounts, and auth-provider setup state while preserving tenants, printers, library files, jobs, and other app data, run `npm run db:reset-auth`. The script reseeds built-in platform roles and each existing tenant's built-in roles after the reset.

## Slicer sidecar in development

The devcontainer Compose stack includes a standalone slicer service on port `4010`, but it is opt-in rather than auto-started. Start it manually with `docker compose up -d slicer` when you want to use the bundled local worker. The slicer image downloads the latest stable BambuStudio AppImage from `bambulab/BambuStudio` during Docker build unless you provide an explicit override. During the image build, PrintStream also generates BambuStudio's `machine_full`, `process_full`, and `filament_full` preset caches from the bundled profile JSONs so CLI slicing has the same default preset data normally prepared during UI setup. The default CLI argument template is `--slice {plate} --debug 2 --outputdir {outputDir} --min-save --export-3mf {outputFileName} {input}`.

Use `BAMBUSTUDIO_APPIMAGE_URL` only when you want to pin a specific AppImage URL instead of using GitHub's latest stable release. Use `BAMBUSTUDIO_APPIMAGE_ASSET_REGEX` if the upstream release contains multiple AppImage assets and you need to force a particular filename pattern.

`SLICER_SERVICE_URL` comes from your local env file rather than the devcontainer definition. If you want to use the bundled slicer instead of a remote worker, start it with `docker compose up -d slicer` and point your local env at `http://slicer:4010`. To verify the sidecar after starting it, run:

```bash
curl http://slicer:4010/health
```

Then run `npm run dev`, upload an unsliced `.3mf` project to the library, and use the file action menu's `Slice` command. The slicer runs BambuStudio under isolated `HOME` and XDG config/cache directories inside the slicer work volume so first-run state does not use the container user's default home. The exact `SLICER_CLI_ARGS_TEMPLATE` must match the CLI flags supported by the BambuStudio build you install; PrintStream substitutes `{input}`, `{output}`, `{outputDir}`, `{outputFileName}`, 1-based `{plate}`, `{plateZeroBased}`, `{homeDir}`, `{configDir}`, `{cacheDir}`, and `{dataDir}`.

On **x86** the slicer runs inside the workspace container automatically as part of `npm run dev` (it bootstraps BambuStudio into a named volume on first run; see the slicer development notes). On **arm64** (BambuStudio is x86-only) `npm run dev` instead bootstraps an x86-64 **qemu-user emulation** environment and runs the same slicer locally under emulation — slower than native but real, local slicing with no remote dependency (first run downloads ~400MB once; see the slicer development notes). Set `PRINTSTREAM_DEV_SLICER=remote` to skip the local slicer and point `SLICER_SERVICE_URL` in your local `.env` at a reachable x86 slicer (e.g. staging) instead.

The default CLI template includes `--export-json` so the slicer generates metadata (estimated print time, filament weight, filament cost) which the web UI displays in the slicing progress toast and final result. The metadata comes from the JSON export file generated during slicing.

BambuStudio CLI logs all diagnostics through stdout/stderr, and some successful slices include upstream `warning` or `error` lines such as missing system preset JSON files or invalid tool-change commands found while analyzing generated G-code. Treat the PrintStream job status and the presence of a saved `.gcode.3mf` artifact as authoritative; the slicer only fails the job when the CLI exits non-zero or no output artifact is produced.

## Testing

```bash
npm run test
```

This runs the repo's TypeScript test suite via Node's built-in test runner. `npm run validate` includes linting, tests, typechecking, and Prisma schema validation, so new features should add or update focused regression tests before they are considered complete.

The aggregate test runner runs the whole suite in one `node --test` pass (each file is isolated in its own subprocess) and never stops at the first failure. It caps how many files run at once so a busy/shared CPU does not make timing-sensitive suites flake; the default is about half the cores. Tune it with `npm run test -- --concurrency=<n>` or `NODE_TEST_CONCURRENCY=<n> npm run test` (lower it if you see flakes; that knob also bounds peak memory). Pass a path substring to scope the run, e.g. `npm run test -- print-job-recorder`.

When a run fails, the runner re-runs only the failing files one at a time to pinpoint them and to separate genuine failures from load-induced flakes (a file that fails under the full run but passes alone). It exits non-zero only for reproducible failures.

The aggregate test runner uses Node's compact `dot` reporter by default to keep successful runs readable. Use `npm run test -- --reporter=spec` when you need per-test names while debugging a failure.

## Maintainer utilities

To capture real printer camera media for demos:

```bash
npm run capture:printer-media -- --printer Home --snapshot-count 8 --snapshot-interval-sec 180 --clip-sec 20 --output-dir data/demo-captures/home-h2d-$(date +%Y%m%d-%H%M%S)
```

The command reads the target printer from Prisma, saves timestamped JPEG snapshots, and optionally records a short MP4 clip from the live chamber stream. It uses the current `DATABASE_URL`, so once your local database points at the populated dev database no extra overrides are needed.

If you refresh the branded web assets, keep `apps/web/public/icon.svg` as the default icon source, `apps/web/public/maskable-icon.svg` as the Android launcher-safe source, and regenerate the derived PNG install assets with:

```bash
npm run export:web-icons
```
