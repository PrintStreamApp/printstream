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
docker/dev/   Development process image
```

## Quick start

The editor stays on the host. Docker runs the Node watchers, PostgreSQL, and optional slicer from
this checkout, with the source tree mounted at `/workspace`. Each worktree receives a separate
Compose project, database volume, and loopback web port; only Traefik is machine-wide.

```bash
cp .env.server.example .env
nvm install
nvm use
npm install
npm run dev:bootstrap   # once per machine
npm run dev
```

The host uses the exact Node/npm pair in `.nvmrc` and `package.json` for the thin launcher. The
image supplies the matching Node 22 runtime plus ffmpeg, PostgreSQL tooling, and the slicer
toolchain. `npm run dev:down` removes this checkout's containers and network while
preserving its database volume. Run `npm run dev:host -- snapshot` when the primary checkout's
current data should become the baseline for new worktrees.

`npm run dev` waits for the local database and applies checked-in Prisma migrations before it starts the API and web watchers. If the database cannot consume the checked-in migration history as-is yet, startup falls back to `db push` and baselines the current checked-in migrations so future deploys can return to normal `migrate deploy` behavior.

That fallback is a compatibility bridge, not a substitute for real migrations. If a feature needs a new table or column, add and commit a real Prisma migration before considering the change complete.

For local schema work, prefer `npm run db:migrate -- <name>` so Prisma records a real migration in `apps/api/prisma/migrations/`.

To clear local auth identities, roles, sessions, service accounts, and auth-provider setup state while preserving workspaces, printers, library files, jobs, and other app data, run `npm run db:reset-auth`. The script reseeds built-in platform roles and each existing workspace's built-in roles after the reset.

## Multi-checkout development

Running several checkouts at once (a few Git worktrees, or two projects that both want port 5173) normally means renumbering ports by hand. Devkit removes that: each checkout gets its own hostname, database, and ports, all derived from its path.

```bash
npm run dev:bootstrap    # once per machine
npm run dev:host -- snapshot     # once, from your primary checkout: capture current dev data as the baseline
npm install              # once per NEW worktree: node_modules is per-checkout, not shared
npm run dev              # in any checkout or worktree
```

Everything a checkout is named by is derived on that first `npm run dev`, so a new worktree needs no setup beyond the install: it gets its hostname, its own database restored from the baseline, its own ports, its proxy route, and a copy of the primary checkout's ignored `.env`. If the worktree already has an `.env`, devkit leaves it alone. Deleting the worktree stops producing its derived resources; `dev:host -- prune` removes the orphaned database volume.

Only one dev stack may run for a checkout. A second `npm run dev` exits before starting watchers and
names the occupied web/API ports. In host mode those ports are part of the proxy identity, so Vite
also refuses a collision instead of silently moving to a URL the checkout hostname does not serve.

The API and bridge run under a shared polling supervisor rather than `tsx watch`. If WSL or the host
kills a service child under memory pressure, the supervisor logs the exit and restarts it with
bounded backoff; edits to service source or compiled shared dependencies also trigger a reload. This
keeps the proxy from remaining alive with a permanently missing API behind it.

After that, `npm run dev` prints where the checkout is answering:

```
  printstream / slice-crash-gate  →  http://slice-crash-gate.printstream.localhost
  direct                          →  http://localhost:31180
```

Hostnames nest as `<worktree>.<repo>.localhost`, which browsers resolve to loopback with no hosts file and no DNS setup. The direct URL is always printed too, so a problem with the proxy never blocks you.

### What it sets up

| Piece | Where | Ownership |
| --- | --- | --- |
| Traefik proxy on IPv4 and IPv6 loopback port 80 | `~/.config/devkit/infra` | every project on the machine |
| Node, Postgres, and the optional slicer | this checkout's Compose stack | this checkout only |
| Baseline database + `data/` archive | `~/.config/devkit/baselines` | every worktree of one clone |

The first `npm run dev` in a new worktree restores the portable SQL baseline and `data/` archive,
then applies whatever migrations that branch adds. It is not seeded empty, because a library with
no files in it is not something you can develop against.

### Commands

| Command | What it does |
| --- | --- |
| `npm run dev:doctor` | prints the state of every precondition, and the command that fixes each |
| `npm run dev:host -- snapshot` | refreshes the portable baseline from the current checkout |
| `npm run dev:host -- reset` | recreates a worktree's database volume; `-- --empty` skips the baseline |
| `npm run dev:host -- prune` | finds volumes whose worktree is gone; add `-- --yes` to remove them |
| `npm run dev:host -- infra` | restarts the machine proxy and this checkout's database |
| `devproxy ls` | every `*.localhost` name registered on this machine, PrintStream's and others' |

Refresh the baseline explicitly when primary-checkout data should become the starting point for new
worktrees. `dev:host -- reset` deliberately refuses on the primary checkout because its database is
the source for snapshots, not disposable state.

### Naming any other project on the machine

The proxy is shared, so anything on the machine can answer on a `*.localhost` name, not just PrintStream checkouts. `npm run dev:bootstrap` puts a `devproxy` CLI on your PATH for that:

```bash
devproxy add myapp 3000                  # http://myapp.localhost
devproxy add issue-123.myapp 3001        # http://issue-123.myapp.localhost
devproxy ls                              # what is registered, and whether it answers
devproxy rm myapp
```

It takes a hostname and a port and knows nothing else, so the target can be a host process or a container publishing a port. The `.localhost` suffix is added when you leave it off and is not optional: browsers resolve `*.localhost` to loopback with no hosts file and no DNS, which is what makes the whole design setup-free (Windows resolves it too, so a WSL dev server is reachable from a Windows browser by name).

Two differences from the routes `npm run dev` writes, which `devproxy ls` labels `checkout`: a `devproxy` route is permanent until you remove it, where a checkout's is tied to that dev server's lifetime; and `devproxy rm` refuses to delete a checkout's route, because the next `npm run dev` would just write it back.

`dev:bootstrap` links the package's `devkit` and `devproxy` executables into `~/.local/bin`. Re-running it refreshes those links while leaving the installed stack under `~/.config/devkit/infra` alone.

### Local configuration in worktrees

Devkit's `worktreeFiles` allowlist in `devkit.config.mjs` names ignored local configuration a new worktree needs. PrintStream lists `.env`, so the first `npm run dev` copies the primary checkout's file before loading it. Copying is create-only: edit a worktree's `.env` when that branch needs different values and later starts will preserve it.

Devkit publishes its derived `DATABASE_URL` into the development processes it starts. Tests,
validation, and the Prisma CLI still read `.env` directly, which is why inheriting the primary
checkout's file matters.

Shared implementation lives in `@ryanewen/devkit`; PrintStream's ports, environment, inherited files, baseline paths, and project-specific checks live in `devkit.config.mjs`.

## Slicer sidecar in development

By default the slicer runs in the same place as the rest of the dev stack: `npm run dev` starts it on port `4010` alongside the API and web watchers (see the architecture note further down for the x86 and arm64 paths). A host without the native toolchain can opt into the Compose sidecar described below. The slicer image downloads the latest stable BambuStudio AppImage from `bambulab/BambuStudio` during Docker build unless you provide an explicit override. During the image build, PrintStream also generates BambuStudio's `machine_full`, `process_full`, and `filament_full` preset caches from the bundled profile JSONs so CLI slicing has the same default preset data normally prepared during UI setup. The default CLI argument template is `--slice {plate} --debug 2 --outputdir {outputDir} --min-save --export-3mf {outputFileName} {input}`.

Use `BAMBUSTUDIO_APPIMAGE_URL` only when you want to pin a specific AppImage URL instead of using GitHub's latest stable release. Use `BAMBUSTUDIO_APPIMAGE_ASSET_REGEX` if the upstream release contains multiple AppImage assets and you need to force a particular filename pattern.

`SLICER_SERVICE_URL` comes from your local env file, and `npm run dev` points it at the slicer it started for you. Override it only to use a remote worker instead. To verify the local slicer once `npm run dev` is up, run:

```bash
curl http://localhost:4010/health
```

Then upload an unsliced `.3mf` project to the library, and use the file action menu's `Slice` command. The slicer runs BambuStudio under isolated `HOME` and XDG config/cache directories inside the slicer work volume so first-run state does not use the container user's default home. The exact `SLICER_CLI_ARGS_TEMPLATE` must match the CLI flags supported by the BambuStudio build you install; PrintStream substitutes `{input}`, `{output}`, `{outputDir}`, `{outputFileName}`, 1-based `{plate}`, `{plateZeroBased}`, `{homeDir}`, `{configDir}`, `{cacheDir}`, and `{dataDir}`.

On **x86** the slicer runs alongside the other watchers automatically as part of `npm run dev` (it bootstraps BambuStudio into a named volume on first run; see the slicer development notes). On **arm64** (BambuStudio is x86-only) `npm run dev` instead bootstraps an x86-64 **qemu-user emulation** environment and runs the same slicer locally under emulation: slower than native but real, local slicing with no remote dependency (first run downloads ~400MB once; see the slicer development notes). Set `PRINTSTREAM_DEV_SLICER=remote` in `.env` to skip the in-process slicer and point `SLICER_SERVICE_URL` at a reachable slicer instead.

### Running the slicer as a container instead (host machines)

The development process image includes BambuStudio's runtime libraries and, on arm64, `qemu-user-static`, the x86-64 cross toolchain (`gcc-x86-64-linux-gnu`, `libc6-dev-amd64-cross`), and `weston`.

The slicer image already carries the lot, including the arm64 emulation sysroot, so a host machine can run the same engine without installing any of it:

```bash
docker compose -f compose.dev.yml --profile slicer up -d slicer
```

Then set `PRINTSTREAM_DEV_SLICER=remote` in `.env` (`run-dev.mjs` reads `.env`, so it does not need to be a shell prefix) and leave `SLICER_SERVICE_URL=http://127.0.0.1:4010`. `npm run dev` then starts no slicer of its own and the API uses the container.

**It builds from THIS checkout**, so the container runs the code you are editing, and the engine downloads once into a named volume that survives rebuilds. Measured on an arm64 host: about 1m40s for a full build, 14s to rebuild after a slicer source change, 4s when nothing changed.

`npm run dev` rebuilds the container when your slicer source is newer than its image. The build is layer-cached, and after a successful rebuild dirty source is recognised as current rather than rebuilt again on every start. `dev:doctor` reports the same state without changing it and names the manual command:

```bash
docker compose -f compose.dev.yml --profile slicer up -d --build slicer
```

To skip building entirely when you are not touching the slicer, point `SLICER_IMAGE` at the published engine and pull it instead.

The default CLI template includes `--export-json` so the slicer generates metadata (estimated print time, filament weight, filament cost) which the web UI displays in the slicing progress toast and final result. The metadata comes from the JSON export file generated during slicing.

BambuStudio CLI logs all diagnostics through stdout/stderr, and some successful slices include upstream `warning` or `error` lines such as missing system preset JSON files or invalid tool-change commands found while analyzing generated G-code. Treat the PrintStream job status and the presence of a saved `.gcode.3mf` artifact as authoritative; the slicer only fails the job when the CLI exits non-zero or no output artifact is produced.

## Testing

```bash
npm run test
```

This runs the repo's TypeScript test suite via Node's built-in test runner. `npm run validate` includes linting, tests, typechecking, and Prisma schema validation, so new features should add or update focused regression tests before they are considered complete. Validate runs its stages at the lowest CPU scheduling priority (`scripts/dev/run-low-priority.mjs`), so it can share a machine with the running dev servers without starving them; it only takes longer when something else actually wants the CPU.

### Validate is incremental

`npm run validate` skips test files it has already proved green. Each file is keyed on a digest of its own bytes plus its whole first-party import graph, plus the things no graph contains (the lockfile, the tsconfigs, the runner itself, and the environment the runner keys off). Change one file and only the tests whose graph reaches it re-run; change nothing and no test runs at all. The typecheck stage is incremental too, so an unchanged program replays its diagnostics from the buildinfo instead of re-checking.

The cache lives outside the tree, under `${XDG_CACHE_HOME:-~/.cache}/printstream-validate/<clone>/`, keyed on the git *common* dir. That means **every worktree of a clone shares it**: a worktree that only touched `apps/web` inherits the api, shared, bridge and slicer results the main checkout already proved.

Three rules worth knowing, because they are what makes the cache safe to trust:

- **Only a fully green run records anything.** A failed run teaches the cache nothing, deliberately: attributing per-file results from a failure would mean trusting output parsing to have spotted every failure, and a file wrongly recorded as green would vanish from the suite until its bytes changed.
- **A file whose digest cannot cover everything it depends on is never cached.** That is any test with an unresolvable dynamic import, and any test that reads the repo from disk (the `apps/web/src` convention guards, the fixture readers). About 60 of the 760 files run every time. Add `@validate-cache-never` in a comment to opt a test out by hand.
- **Skipping is always printed.** A cached run says how many files it skipped; it must never read like a full run.

Controls: `npm run test -- --no-cache` (or `PRINTSTREAM_NO_TEST_CACHE=1`) ignores it for one run, `npm run test -- --clear-cache` empties it. Deleting the cache directory is always safe and costs one slow run.

Measured on a 12-core development container, test stage only (add roughly 9s for lint, script tests, typecheck and prisma validate):

| Working tree | Test files run | Test stage |
| --- | --- | --- |
| Cold cache | 760 | 95s |
| Unchanged since a green run | 61 | 8s |
| One `apps/api/src/lib` file changed | 88 | 13s |
| One `apps/web/src/lib` file changed | 71 | 17s |
| One `packages/shared/src` file changed | 430 | 82s |

The last row is the cache working correctly rather than failing: 430 test files genuinely reach that module. The 61-file floor is the always-run set described above.

### Validate serialises across worktrees

Concurrent full validates do not finish sooner in aggregate: the CPU is already saturated by one run, because each `node --test` child uses about two cores. Running three at once instead made each take 375s rather than 110s and produced load-induced flakes that never occur solo. So `npm run validate` takes a repo-wide lock (`scripts/dev/run-exclusive.mjs`) and queues behind any other validate on the same clone, reporting who it is waiting for. `PRINTSTREAM_NO_REPO_LOCK=1` runs anyway.

`npm run validate:changed` deliberately does **not** take the lock, because it is the inner loop and must never be blocked by someone else's full gate.

### The inner loop

`npm run validate:changed` is the fastest feedback path: it lints only the changed files, typechecks in full (TypeScript is whole-program, so this is what catches a changed shared module breaking a consumer elsewhere), and runs tests scoped to each changed file's subtree. It prints the scopes it chose and names what it could not cover. It is a subset by construction, not a gate: behavioural breakage in a consumer outside those subtrees is not covered. Use it while iterating; use `npm run validate` before you commit.

The aggregate test runner runs the whole suite in sequential batches of 50 files, and Node isolates each file in its own subprocess. The batch boundary releases the aggregate process's native memory and test metadata instead of retaining them across the entire suite; failures are still collected across every batch before reporting. An unattributed failed batch is re-run file-by-file so aggregate pressure cannot hide the responsible test. Within a batch, concurrency is capped so a busy/shared CPU does not make timing-sensitive suites flake. The default is the lowest of half the available cores, four workers, and a memory budget that reserves 3 GiB for dev servers and the host before allowing about 1.5 GiB per worker. This matters in WSL and memory-capped containers, where CPU-only sizing can otherwise fill swap. Tune concurrency explicitly with `npm run test -- --concurrency=<n>` or `NODE_TEST_CONCURRENCY=<n> npm run test` when a dedicated machine can sustain more. The batch size can be overridden with `--batch-size=<n>` or `NODE_TEST_BATCH_SIZE=<n>` for diagnostics. Pass a path substring to scope the run, e.g. `npm run test -- print-job-recorder`.

When a run fails, the runner re-runs only the failing files one at a time to pinpoint them and to separate genuine failures from load-induced flakes (a file that fails under the full run but passes alone). It exits non-zero only for reproducible failures.

The aggregate test runner uses Node's compact `dot` reporter by default to keep successful runs readable. Use `npm run test -- --reporter=spec` when you need per-test names while debugging a failure.

## Maintainer utilities

If you refresh the branded web assets, keep `apps/web/public/icon.svg` as the default icon source and `apps/web/public/maskable-icon.svg` as the Android launcher-safe source. Regenerate the derived PNG install assets by rendering the SVG in a browser and writing the normalized square PNGs from that render, never with a CLI rasterizer: see the branded-asset rule in the web development notes and `apps/web/public/README.md`.
