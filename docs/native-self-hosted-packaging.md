# Native self-hosted packages (Node SEA) — strategy

> **Status:** Proposed (design/strategy). No code yet. This document is the plan
> of record for shipping the self-hosted OSS app as native single-file
> executables, the way the cloud bridge already ships.
>
> **Open-core classification: PUBLIC.** Unlike the bridge standalone build (which
> is the cloud distribution and lives under `private/`), the self-hosted native
> build is a feature of the open-source core. This doc, the packaging scripts, and
> the new runtime code described here ship in the public snapshot
> (`npm run export:public`). Cloud-only material referenced here (the bridge's
> `private/sea/**`, maintainer signing secrets, ops scripts) stays excluded.

## Goal

Let a self-hoster run the whole app by downloading and double-clicking one signed
executable — no Docker, no Compose, no separate database to operate — on Windows,
a Raspberry Pi, or a Linux box. The same `service install` / tray / status
experience the standalone bridge already offers, but for the full stack.

### Non-goals (v1)

- **Server-side slicing is not embedded.** [apps/slicer](../apps/slicer/) shells out
  to multi-GB external slicer CLIs; bundling them in a SEA is a non-starter.
  Client-side slicing / model-studio still work. Advanced users point
  `SLICER_SERVICE_URL` at a separately-run slicer (Docker). This is the one
  capability the native build trades away — call it out in the download UI.
- **Horizontal scale / multi-tenant cloud surface.** The native build is a
  single-workspace, single-box install (the same shape as managed-bridge mode).
- **In-place self-update** is phase 2 (see Roadmap). Phase 1 ships an
  "update available" check only.

## Why this is not "just the bridge again"

The cloud bridge is the easy case of SEA packaging: one stateless outbound client
process, a single heavy native dep (ffmpeg), no database, no UI to serve, and it
is closed-source/cloud-only. A full-stack self-hosted build inverts both axes:

| | Cloud bridge (today) | Self-hosted native (this plan) |
|---|---|---|
| Processes | one | API + web + in-box bridge + Postgres |
| State | a state file + library dir | a full relational database |
| Serves a UI | no | yes, on one port |
| Open-core side | **private** (cloud distribution) | **public** (OSS core) |
| Versioning | content-addressed, lockstep with server | **semver + GitHub Releases** |

The SEA *mechanics* transfer cleanly. The *system* being packaged is bigger, and
it lands on the opposite side of the open-core split.

## What reuses directly from the bridge work

The bridge build is already factored for reuse — its service-spec header says
so.
These transfer with little change:

- **The SEA build pipeline**: esbuild→CJS
  bundle, download + checksum the per-target official Node binary, generate the
  blob, `postject` inject, brotli-compress embedded assets, Windows signing. The
  build targets (Linux x64/arm64, Windows x64) and the download-cache /
  checksum harness apply directly.
- **The generic service plumbing**, deliberately kept non-bridge-specific:
  `ServiceSpec` + the systemd / launchd / WinSW controllers, `paths.ts`,
  `config-file.ts`, `single-instance.ts`, `setup.ts`, the status-file + control-
  socket model, the tray, and the self-update driver.
- **Embedded ffmpeg** — the
  camera relay path spawns ffmpeg via `BRIDGE_FFMPEG_PATH`, so the same
  brotli-embedded static binary works unchanged.
- **Signing infra** — the Windows Azure Trusted Signing CI split already exists
  and applies as-is.

## Architecture of the bundled box

One executable supervises everything; one TCP port faces the user.

```
                       printstream  (single executable)
  ┌──────────────────────────────────────────────────────────────┐
  │  sea-entry → bootstrap → CLI dispatch (setup/service/run/...)  │
  │                                                                │
  │  on `run`:                                                     │
  │    1. start embedded Postgres  ──►  <dataDir>/db   (child)     │
  │    2. apply migrations (bundled query engine)                  │
  │    3. start managed bridge  ───────────────────►  LAN printers │
  │       (auto-pairs via provisioning-token file)                 │
  │    4. start API (Express + WS)  ─┐                             │
  │    5. serve web/dist + SPA + /api + /ws on ONE port ◄── browser│
  │                                                                │
  │  embedded assets: web/dist, ffmpeg(.br), Postgres binaries,    │
  │                   prisma query engine, migrations SQL, WinSW   │
  └──────────────────────────────────────────────────────────────┘
```

## The five subsystems

> **Foundations status (Phases 1–2):** the database groundwork below is
> **implemented and Linux-verified** ahead of any SEA packaging — Prisma
> `binaryTargets`, a CLI-free boot migration applier, and an embedded-Postgres
> supervisor with a BYO fallback. The SEA entry, `packages/sea-runtime`
> extraction, CI/signing, and self-update remain pending (Phases 3–5).

### 1. Database — embedded PostgreSQL (decided)

The schema in [schema.prisma](../apps/api/prisma/schema.prisma) is Postgres-only in
ways that are not cosmetic: `String[]` array columns (`permissions`,
`transports`), `Json` columns, `@db.Decimal`, and hand-written Postgres SQL in
[jobs.ts:352](../apps/api/src/routes/jobs.ts#L352) (`NULLS FIRST`, quoted
identifiers). "Just use SQLite" would be a real migration plus a permanent dual-DB
maintenance tax, so we **embed PostgreSQL** instead and keep the schema,
migrations, and raw SQL **byte-identical to the Docker stack** — zero divergence
is what keeps this maintainable.

- Ship a per-platform portable Postgres. **Decided:** the `embedded-postgres`
  package (zonky-style binaries, Postgres 18), which publishes a **real
  `linux-arm64` build** for the Raspberry Pi target as well as `linux-x64` and
  `windows-x64` — no emulated borrow needed. For SEA these get brotli-embedded as assets like
  ffmpeg; the foundations build consumes the npm package directly.
- **Implemented** ([embedded-postgres.ts](../apps/api/src/lib/embedded-postgres.ts)):
  `startEmbeddedPostgresIfEnabled()` `initdb`s a cluster under the data dir on
  first run and creates the `printstream` database. It binds **no TCP port**:
  on Linux/macOS the cluster listens on a **Unix domain socket only** (so it can
  never collide with another app's port); on Windows — where Postgres/Prisma
  socket support is unreliable — it binds a **loopback port chosen free at
  startup**. `EMBEDDED_POSTGRES_PORT` pins a fixed loopback port if a self-hoster
  wants one. The API connects via the `DATABASE_URL` it returns.
- **BYO-Postgres fallback:** the `EMBEDDED_POSTGRES` switch gates the cluster
  (off by default — Docker, cloud, and self-hosters who run their own Postgres
  set `DATABASE_URL` and leave the switch off).
- **Single-instance guard:** Postgres' own `postmaster.pid` is the lock — a
  second app instance on the same data dir refuses with a clear error (stale
  pidfiles from a crash are ignored). Clean shutdown drains the API first, then
  the embedded-postgres exit hook stops the cluster (`persistent`, so an abrupt
  stop only costs a crash-recovery on next start). A shared `single-instance.ts`
  converges here when `packages/sea-runtime` is extracted.

Open items (deferred to the SEA phase): pin the Postgres asset checksums (ffmpeg
pattern) once the binaries are embedded rather than npm-installed; the
`embedded-postgres` package currently versions as `-beta` only — pin it.

### 2. Prisma engines + migrations at boot

- **Done:** `binaryTargets` is set in the generator block
  ([schema.prisma](../apps/api/prisma/schema.prisma)) so the **query engine** is
  generated for all six targets up front; SEA embeds the right engine per build.
- **Done:** migrations apply on startup **without the Prisma CLI**
  ([apply-migrations.ts](../apps/api/src/lib/apply-migrations.ts), wired in
  [server.ts](../apps/api/src/server.ts) before the env module / Prisma load).
  The checked-in history is **not replayable from empty** — the earliest
  migration assumes pre-history auth tables, the same baseline gap the Docker CLI
  bootstrap recovers from with `db push` + baseline. So the applier follows
  Prisma's **baseline** workflow: a fresh cluster is materialized from a checked-in
  full-schema snapshot ([prisma/baseline.sql](../apps/api/prisma/baseline.sql),
  regenerated by `npm run prisma:baseline` — kept in sync by a drift test) and
  every migration is baseline-marked; an existing database forward-applies only
  new migrations. The normal first-run default-workspace bootstrap
  (`AUTO_CREATE_DEFAULT_WORKSPACE`) then runs unchanged.

### 3. Serving the web on one port (new core feature) — **done**

Implemented: the API serves the built `web/dist` with SPA fallback alongside
`/api` and `/ws` on a single port, gated behind `SERVE_WEB_DIR`
([serve-web.ts](../apps/api/src/lib/serve-web.ts)). The Docker stack is now
single-container by default (the api image embeds the web bundle and bakes
`SERVE_WEB_DIR`; the separate `web`/nginx container is gone — see
[docs/deployment.md](deployment.md)). This is a **core/public** feature, useful
beyond SEA, and the SEA build reuses it by embedding the same `web/dist` as an
asset and pointing `SERVE_WEB_DIR` at the extracted path.

### 4. The in-box bridge

A single-host build still needs LAN access to printers. Reuse **managed-bridge
mode** ([managed-bridge.ts](../apps/api/src/lib/managed-bridge.ts)): run the bridge
as a co-process (or in-process) that auto-pairs via the provisioning-token file,
exactly as the Docker `bridge` service does. Bridges settings stays hidden; there
is nothing to pair by hand. SSDP multicast works natively here (no Docker bridge
network in the way), which is actually simpler than the Compose default.

### 5. The slicer (out of the binary)

Ship with server-side slicing disabled by default; document `SLICER_SERVICE_URL`
for users who run a separate slicer. See Non-goals.

## The open-core inversion (most important architectural call)

The bridge SEA is private because it *is* the cloud distribution. The self-hosted
native build is the opposite — it must live in the **public** snapshot produced by
the public export. But the reusable plumbing
it wants currently sits in the bridge's `private/sea/` tree, which the export strips,
and **core must never import from `private/`**.

So we **extract the generic, non-cloud plumbing into a shared public package** —
proposed `packages/sea-runtime` — that both builds consume:

- **Public `packages/sea-runtime`** gets: the SEA build harness, `ServiceSpec` +
  per-OS service controllers, `paths`, `config-file`, `single-instance`, status
  file, control socket, tray, embedded-asset (ffmpeg/Postgres) extraction, and the
  generic self-update driver — all parameterized by a service spec and an asset
  manifest, with no `printstream.app` / cloud assumptions.
- **The bridge's `private/sea/`** keeps only what is genuinely cloud-specific:
  the `printstream.app` server default, `migrate-docker.ts`, and the cloud
  connect-code deep links.
- **A new public `apps/server` (or `apps/api/sea`) entry** composes
  `packages/sea-runtime` with the API/web/DB/bridge boot sequence.

The bridge code is already shaped for this seam (the spec was written generic on
purpose). Doing the extraction up front keeps both builds in lockstep and avoids a
mirror-maintenance burden like the 3MF index parser, which used to be hand-copied
between the API and the bridge before it was unified into `@printstream/shared/three-mf`.
Re-pointing the existing bridge at the extracted package — with no behavior change —
is the test that the seam is clean.

## Build pipeline

A `build-sea` for the full stack, modeled on the bridge's SEA build script but living in public
`packages/sea-runtime` / `apps/server`:

1. `npm run build` (shared + web `vite build` + API `tsc`).
2. esbuild-bundle the new public `sea-entry` to CJS (version + git rev baked in).
3. Generate the SEA blob with embedded assets: `web/dist` tree, ffmpeg(.br),
   per-target Postgres(.br), the Prisma query engine, the migrations SQL, and
   (Windows) WinSW.
4. Copy the per-target official Node binary (checksum-verified), `postject` the
   blob, sign (Windows via the existing CI split).
5. Emit `SHA256SUMS` and per-platform artifacts under
   `apps/server/release/sea/<version>/`.

Binary size will be larger than the bridge (~140–150 MB) because of Postgres + the
web bundle — budget ~200–250 MB uncompressed, with `.gz` transfer copies as the
bridge already does.

### SEA-build prerequisites (discovered — must be solved before step 2 works)

A feasibility pass (esbuild-bundling `apps/server` + running the single file)
turned up three concrete blockers the bridge never hit, because the bridge has no
Prisma, no Postgres, and no web bundle. None are cross-OS testable in the Linux
devcontainer; they want real-hardware verification once unblocked.

1. ~~**Prisma can't go inside the JS bundle.**~~ **Resolved (BYO-Postgres binary
   builds and runs).** The build (`apps/server/scripts/build-sea.mjs`) marks
   `@prisma/client` + `.prisma/client` esbuild-**external**, zips the generated
   client (engine pruned to the host target) into a `prisma-client.zip` SEA
   **asset** (and the web bundle into `web.zip`); the runtime
   (`apps/server/src/sea-assets.ts`) extracts them to `<dataDir>/runtime` on first
   run. **Key extra discovery:** a SEA's *embedded* `require()` only loads
   built-in modules and ignores `NODE_PATH`, so the bundle's
   `require('@prisma/client')` must go through a `createRequire()` bound to the
   extracted dir — the build banner installs a disk-require shim that
   `prepareSeaRuntime` points at the extraction dir. No `PRISMA_QUERY_ENGINE_LIBRARY`
   needed (the engine sits next to the extracted client). **Verified:** a single
   138 MB `printstream` binary serves the SPA + API **and** auto-pairs the in-box
   bridge on one port against a BYO `DATABASE_URL` (`bootstrap` 200, `GET /` →
   `<title>PrintStream</title>`, `auto-paired bridge … into workspace`).
2. ~~**Node SEA is CommonJS-only, but the API uses top-level `await`.**~~
   **Resolved.** The two `await mkdir(...)` in `routes/library.ts` are now
   `mkdirSync`, and `app.ts`'s `await registerPrivateModules(app)` moved into an
   exported `finalizeApp()` (private modules + SPA fallback + error handler) that
   `index.ts` awaits before `listen()` — preserving route order. The server now
   esbuild-bundles to CJS cleanly (verified), and the full stack still boots with
   the private cloud module mounted.
3. ~~**`embedded-postgres` resolves its binaries from `node_modules`.**~~
   **Resolved — the binary runs its own embedded PostgreSQL.** Rather than
   reimplement the supervisor, an esbuild **plugin** (`build-sea.mjs`) swaps
   `embedded-postgres`'s `binary.js` `getBinaries()` to read the binary dir from
   `EMBEDDED_POSTGRES_BIN_DIR`, reusing all of its initdb/start/stop lifecycle.
   The host's `@embedded-postgres/<platform>/native` (~60 MB) is embedded as
   `postgres.zip` and the migration history + `baseline.sql` as `migrations.zip`;
   `sea-assets.ts` extracts both on first run (recreating the lib symlinks npm
   can't pack, from the shipped `pg-symlinks.json`) and sets
   `EMBEDDED_POSTGRES_BIN_DIR` + `PRINTSTREAM_MIGRATIONS_DIR`/`PRINTSTREAM_BASELINE_SQL`
   (which `apply-migrations` now honors). **Verified:** the 160 MB binary with
   **no external database** runs `initdb`, applies the baseline + 23 migrations,
   creates the default workspace, serves the SPA + API, and auto-pairs the in-box
   bridge — and a restart reuses the cluster (`Database is up to date`).

~~Recommended order: (2) → (1) → (3).~~ **All three resolved**, and the build is
now **cross-target-structured**: `build-sea.mjs` takes `--target <key>` (linux-x64,
linux-arm64, win32-x64; default the host), downloads the
pinned Node for the target (checksum-verified) and a host Node of the same version
for blob generation (the blob is version-specific), and selects the per-target
Prisma engine + `@embedded-postgres/<key>` Postgres asset. The build **self-fetches** each target's portable PostgreSQL via `npm pack` (the
`@embedded-postgres/<key>` packages have os/cpu guards that block a normal
cross-platform `npm install`), so a single Linux host cross-builds every target.
**Verified by building, from this Linux/arm64 box:** `linux-arm64` (runs the full
embedded stack end-to-end) and `linux-x64` (x86-64 ELF). The guided first-run (`setup` / bare launch) **installs the app as a
background OS service** (self-elevating: UAC on Windows, osascript/pkexec on
macOS/Linux), **starts the notification-area tray**, and opens the browser — it
no longer runs the stack in a foreground terminal window. The public release
workflow (`.github/workflows/server-packages.yml`)
**publishes to GitHub Releases with Windows Authenticode signing**, **content-
addressed like the bridge — no semver versions**. Every push to the OSS repo's
`main` (i.e. each export snapshot) computes a release fingerprint
(`scripts/server-release-fingerprint.sh`); if a `server-<fp12>` Release already
exists the build is skipped, otherwise a Linux `build` job cross-builds all
targets (stripping Node's Windows signature post-injection so the `.exe` is
re-signable), a `windows-latest` `sign-windows` job Authenticode-signs the `.exe`
via Azure Trusted Signing (auto-skipped until `TRUSTED_SIGNING_*` is configured),
and a `release` job overlays the signed `.exe` and attaches every target to a new
Release whose tag *is* the fingerprint (the release action creates it — no manual
tagging). The job is gated to `github.repository == 'PrintStreamApp/printstream'`
so it no-ops in the private monorepo.

Signing matches the bridge: the Windows `.exe` is Authenticode-signed (Azure
Trusted Signing); Linux is unsigned, as on the bridge.

What remains needs maintainer action / hardware, not new design:

- **Repo config** — add the Azure Trusted Signing variables/secret to the public
  repo and grant the service principal the signer role (reuse the bridge's). The
  release then fires automatically on the next export push; no trigger to wire.
- **run** the non-host artifacts on real Windows / x64-Linux hardware
  (the guided service-install + tray flow is Windows-only behavior that
  cannot be exercised on the Linux build host).
- **self-update** (reuse the bridge's driver against the signed Release assets).
  The tray's "Update" item is already wired but stays hidden until the status
  file reports `updateAvailable`, which the self-updater will set.
The build *mechanics* are also unified: the shared SEA harness lives in public
`packages/sea-runtime/scripts/build-harness.mjs` (exported as
`@printstream/sea-runtime/build`) — the per-target Node download table,
checksum-verified Node acquisition, SEA blob generation, postject injection, and
the Windows signing step. Both the bridge's private build script and the
server's public build script import it; each keeps only what differs (which entry
to bundle, which assets to embed, the release identity).

## Distribution, signing, updates

- **Versioned, unlike the bridge.** The app *is* the server, so use **semver tags
  + GitHub Releases** on the public repo — not the bridge's content-addressed
  lockstep model.
- **CI:** a new public workflow builds the Linux + Windows targets, reusing the
  existing Windows Azure Trusted Signing stage, and uploads to GitHub Releases.
  (Signing secrets stay maintainer-only; an unsigned community build still works
  with the usual SmartScreen friction.)
- **Updates (phase 2):** in-place self-update reusing the self-update driver
  mechanics, with the trust source swapped from the cloud manifest to signed
  GitHub release assets. Phase 1: an "update available" check only.

## Phased roadmap

1. **Foundations (core, public, no SEA yet):** **Done.**
   - ~~`SERVE_WEB_DIR` static + SPA serving in the API (§3).~~ — the Compose stack
     is single-container; the SEA build will reuse it.
   - ~~`binaryTargets` in the Prisma generator (§2).~~
   - ~~Boot-time migration applier usable against an arbitrary fresh cluster (§2),
     via a checked-in baseline snapshot + forward apply.~~
   These are independently useful (single-container Compose) and low-risk.
2. **Embedded Postgres (§1):** **Done (foundations).** spawn/supervise
   per-platform Postgres against a data dir; `EMBEDDED_POSTGRES` switch with
   `DATABASE_URL` BYO fallback; lifecycle + `postmaster.pid` single-instance
   guard. Remaining for SEA: brotli-embed the binaries as assets (vs the npm
   package) and the Unix-socket/peer-auth hardening.
3. **Extract `packages/sea-runtime`:** move generic plumbing out of
   `apps/bridge/src/private/sea/`; re-point the bridge at it with no behavior
   change (validates the seam). **Done.** The public package exists and is
   fully self-contained (node built-ins only — no `@printstream/shared`, no bridge
   imports) and now owns:
   - the dotenv config-file helper and the single-instance lock;
   - the full per-OS **service controller** subsystem (`ServiceSpec` +
     systemd/launchd/WinSW), parameterized by the spec and — for systemd's
     `Documentation=` and WinSW's binary — by an optional `documentationUrl` and
     an injected `resolveWinswAsset`;
   - the **per-OS path layout** primitives, parameterized by a
     `StandaloneAppIdentity` (appId / display name / launchd labels). The bridge's
     `paths.ts` is now a thin wrapper that pins the bridge identity and composes
     its own domain files, so every other bridge module imports paths unchanged;
   - the **control channel** (named pipe / Unix socket client + server), with the
     server generalized over a `ControlProvider` interface (the bridge's
     `LocalStatusProvider` satisfies it structurally);
   - the **full tray subsystem** — assets + per-OS provider scripts (`icons`,
     Windows/macOS/Linux generators) *and* the orchestrators (`runner`,
     `launcher`, `autostart`), parameterized by the `StandaloneAppIdentity`. The
     bridge keeps three ~10-line wrappers that bind its identity (the same
     thin-wrapper pattern as `paths.ts`), so every tray call site is unchanged and
     the generated launcher/autostart entries are byte-identical.

   The bridge re-points to `@printstream/sea-runtime` with byte-identical output;
   `npm run validate` (all 257 test files), the moved/new unit tests, and the
   public-build-without-`private/` check all pass. The package is **fully
   self-contained** (node built-ins only — no `STANDALONE_*` identity, no
   `@printstream/shared`). Genuinely cloud-specific code stays in the bridge by
   design: the `printstream.app` defaults, `migrate-docker`, ffmpeg, the bridge
   update driver, connect-code deep links, and `status-types`.

   **Verify cross-OS on real hardware before the app reuses it:** the tray /
   service / launcher paths are typecheck-only here (Linux devcontainer).
4. **Full-stack SEA entry + service install:** **In progress.** New public
   `apps/server` workspace with the `sea-entry` CLI. Its `run` command composes
   the server identity + per-OS data-dir layout (via `packages/sea-runtime`) with
   the foundations engine: it sets the single-box environment (embedded Postgres
   under the data dir, library/plugins dirs, `SERVE_WEB_DIR`) and then imports
   `@printstream/api/server`, which brings up embedded Postgres → CLI-free migrate
   → **API + web on one port**. Verified end-to-end from source on Linux
   (`printstream run` → `initdb` + baseline 23 migrations + default workspace +
   HTTP 200; `status` reports liveness via a status file cleared on clean exit).
   The `service install/uninstall/start/stop/status` commands build the server's
   `ServiceSpec` and dispatch to the generic sea-runtime controllers.

   The **in-box managed bridge** is also done: `run` starts the bridge runtime
   **in the same process** as the API (the bridge is an outbound client, so no
   second port), in managed-bridge mode — it pre-creates the provisioning token,
   sets the bridge env (`BRIDGE_SERVER_URL=http://localhost:<port>`, the shared
   `MANAGED_BRIDGE_TOKEN_FILE`, library/state under the data dir, mirroring the
   Docker `bridge` service), and `@printstream/bridge` exposes a `./runtime`
   export for the in-process boot. Verified end-to-end on Linux: the bridge dials
   the API over loopback, the API **auto-pairs it into the default workspace**,
   and `bridge-state.json` (its identity) persists. `MANAGED_BRIDGE=false` turns
   it off for a remote-bridge setup.

   **Remaining for the binary:** **web-bundle + ffmpeg + Postgres + Prisma-engine
   asset extraction** at first run, the guided `setup` (open browser) and **tray**
   (its provider scripts are still bridge-menu-shaped and need generalizing), and
   the actual **SEA build script** (esbuild → blob → postject → embed assets) —
   mostly Phase 5, and wants real-hardware verification.
5. **CI + signing + GitHub Releases**, then **self-update** (phase 2).

## Risks & open questions

- ~~**Postgres arm64 / Raspberry Pi:** need a real `linux-arm64` portable
  Postgres.~~ **Resolved** — `embedded-postgres` ships a real `linux-arm64` (and
  `linux-arm`) build; no emulation borrow.
- **Binary size:** ~200–250 MB. Acceptable for a desktop app; verify the `.gz`
  transfer copies and embedded-asset brotli ratios.
- **Data-dir migrations & backups:** an embedded DB makes the data dir precious.
  Document backup/restore and a clean upgrade path (migrations run forward on
  start; no destructive `db push`).
- **Extraction scope creep:** keep `packages/sea-runtime` free of any
  printer/bridge/API domain logic — it is service + packaging plumbing only.
- **Public CI without secrets:** the export must produce a repo whose workflow
  builds (unsigned) without maintainer signing secrets, so community forks can
  self-build.

## Manual test checklist (per OS), once built

Mirror the bridge checklist plus the new surfaces. The devcontainer can only
exercise Linux; verify on real hardware before shipping a target:

- `setup` first-run: embedded Postgres `initdb` + migrate + default workspace +
  open browser to the local UI.
- `service install` + reboot persistence; data-dir survives restart.
- Printer discovery via the in-box managed bridge (SSDP) + a real print.
- Camera streaming (embedded ffmpeg).
- BYO-Postgres mode (`DATABASE_URL` set) bypasses the embedded cluster.
- `service uninstall` leaves the data dir intact (backup); reinstall reattaches.
- Crash-loop rollback (phase 2) and `tray` install/run across login.
```
