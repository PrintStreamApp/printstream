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
macOS, Raspberry Pi, or a Linux box. The same `service install` / tray / status
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
  blob, `postject` inject, brotli-compress embedded assets, per-OS signing. The
  six targets (`{linux,win32,darwin} × {x64,arm64}`) and the download-cache /
  checksum harness apply directly.
- **The generic service plumbing**, deliberately kept non-bridge-specific:
  `ServiceSpec` + the systemd / launchd / WinSW controllers, `paths.ts`,
  `config-file.ts`, `single-instance.ts`, `setup.ts`, the status-file + control-
  socket model, the tray, and the self-update driver.
- **Embedded ffmpeg** — the
  camera relay path spawns ffmpeg via `BRIDGE_FFMPEG_PATH`, so the same
  brotli-embedded static binary works unchanged.
- **Signing infra** — macOS ad-hoc / rcodesign and the Windows Azure Trusted
  Signing CI split already exist and apply as-is.

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

### 1. Database — embedded PostgreSQL (decided)

The schema in [schema.prisma](../apps/api/prisma/schema.prisma) is Postgres-only in
ways that are not cosmetic: `String[]` array columns (`permissions`,
`transports`), `Json` columns, `@db.Decimal`, and hand-written Postgres SQL in
[jobs.ts:352](../apps/api/src/routes/jobs.ts#L352) (`NULLS FIRST`, quoted
identifiers). "Just use SQLite" would be a real migration plus a permanent dual-DB
maintenance tax, so we **embed PostgreSQL** instead and keep the schema,
migrations, and raw SQL **byte-identical to the Docker stack** — zero divergence
is what keeps this maintainable.

- Ship a per-platform portable Postgres (e.g. the `embedded-postgres` /
  `zonky`-style binaries, ~30–60 MB/target, brotli-embedded as a SEA asset like
  ffmpeg). On first `run`, extract once to `<dataDir>/pgsql/`, `initdb` a cluster
  under `<dataDir>/db/`, and start it on a loopback socket (prefer a Unix socket /
  named pipe; no public TCP port).
- The API connects via `DATABASE_URL` pointed at that local cluster. A
  **bring-your-own-Postgres fallback** is the documented escape hatch: if the
  operator sets `DATABASE_URL`, skip the embedded cluster entirely.
- Supervise the Postgres child: clean shutdown ordering (drain API → stop
  Postgres), crash restart, and a lock so two app instances cannot open the same
  cluster (reuse `single-instance.ts`).

Open items: pick the binary source + pin checksums (same pattern as the ffmpeg
pin); decide arm64 Linux coverage (Raspberry Pi is a primary target, so a real
`linux-arm64` Postgres build is required, not an emulated borrow).

### 2. Prisma engines + migrations at boot

- Set `binaryTargets` in the generator block (currently unset in
  [schema.prisma](../apps/api/prisma/schema.prisma)) so the **query engine** ships
  for all six targets; embed the right engine per build as a SEA asset.
- Apply migrations on startup **without the Prisma CLI** (the CLI/schema-engine is
  not in the bundle). The Docker stack uses
  [bootstrap-prisma-migrations.mjs](../scripts/bootstrap-prisma-migrations.mjs);
  the native build needs the equivalent that applies the tracked migration SQL
  with the bundled query engine against the freshly-`initdb`'d cluster, then runs
  the first-run default-workspace bootstrap (`AUTO_CREATE_DEFAULT_WORKSPACE`).

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
   blob, sign (macOS codesign/rcodesign; Windows via the existing CI split).
5. Emit `SHA256SUMS` and per-platform artifacts under
   `apps/server/release/sea/<version>/`.

Binary size will be larger than the bridge (~140–150 MB) because of Postgres + the
web bundle — budget ~200–250 MB uncompressed, with `.gz` transfer copies as the
bridge already does.

## Distribution, signing, updates

- **Versioned, unlike the bridge.** The app *is* the server, so use **semver tags
  + GitHub Releases** on the public repo — not the bridge's content-addressed
  lockstep model.
- **CI:** a new public workflow builds the six targets, reusing the existing macOS
  rcodesign + Windows Azure Trusted Signing stages, and uploads to GitHub Releases.
  (Signing secrets stay maintainer-only; an unsigned community build still works
  with the usual Gatekeeper/SmartScreen friction.)
- **Updates (phase 2):** in-place self-update reusing the self-update driver
  mechanics, with the trust source swapped from the cloud manifest to signed
  GitHub release assets. Phase 1: an "update available" check only.

## Phased roadmap

1. **Foundations (core, public, no SEA yet):**
   - ~~`SERVE_WEB_DIR` static + SPA serving in the API (§3).~~ **Done** —
     the Compose stack is single-container; the SEA build will reuse it.
   - `binaryTargets` in the Prisma generator (§2).
   - Boot-time migration applier usable against an arbitrary fresh cluster (§2).
   These are independently useful (single-container Compose) and low-risk.
2. **Embedded Postgres (§1):** spawn/supervise per-platform Postgres against a data
   dir; `DATABASE_URL` BYO fallback; lifecycle + single-instance lock.
3. **Extract `packages/sea-runtime`:** move generic plumbing out of
   `apps/bridge/src/private/sea/`; re-point the bridge at it with no behavior
   change (validates the seam).
4. **Full-stack SEA entry + service install:** new public `sea-entry` that boots
   DB → migrate → managed bridge → API + web on one port; `setup` / service
   install / uninstall / tray via `packages/sea-runtime`.
5. **CI + signing + GitHub Releases**, then **self-update** (phase 2).

## Risks & open questions

- **Postgres arm64 / Raspberry Pi:** need a real `linux-arm64` portable Postgres
  (no x64-emulation borrow like ffmpeg's `win32-arm64`). Confirm a maintained
  source before committing.
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
