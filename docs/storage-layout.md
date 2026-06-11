# Storage Layout (proposal — issue #29)

A design for a **well-defined system for the files PrintStream writes to disk**, so that
persistent data, regenerable caches, and short-lived temp files each have one obvious home
and one lifecycle. This is a proposal: it surveys what exists today, then proposes the target
structure, a helper API, and an incremental migration. Nothing here is implemented yet beyond
the existing pieces noted inline.

## Why

Today the three classes of on-disk files are mixed together and named inconsistently:

- **Caches live inside the data directory.** `bridge-library-files.ts` writes
  `${LIBRARY_DIR}/_bridge-cache` (local copies of bridge files) and
  `${LIBRARY_DIR}/_bridge-derived-cache` (derived 3MF indexes + thumbnails); `hms-codes.ts`
  writes `hms-codes.json` next to `LIBRARY_DIR`. A regenerable cache sitting inside the
  durable library tree means "wipe the cache" risks the library, and a library backup drags
  the cache along.
- **Temp/work dirs are scattered across `os.tmpdir()` with two prefixes.** `printstream-slice-*`,
  `printstream-editor-save-*`, `printstream-slice-arrange-*`, `printstream-slicing-source-*`
  (API) sit beside `bambu-plate-*`, `bambu-storage-3mf-*`, `bambu-bridge-upload-*`,
  `bambu-cover-*` (dispatch/bridge). There is no single root to bound, observe, or sweep, and a
  crash mid-operation orphans a temp dir that nothing ever reclaims.
- **"Hidden" is a DB flag with no location or janitor.** A sliced-without-saving output is a
  normal library file with `hidden = true`, stored next to real files on the bridge. Discard on
  close exists (`discardHiddenSlicedOutput`), but a crash or a closed tab can still strand a
  hidden file with no periodic cleanup.

## Current inventory

Persistent (must survive restarts and be backed up):
- `LIBRARY_DIR` (`./data/library`) — local-copy/fallback library bytes; the bridge owns the
  real library at its own `/data/library`.
- `./data/bridge-releases`, `./data/plugins`, `./data/demo-library`; bridge `/data/bridge-state.json`.

Regenerable cache (safe to delete; rebuilt on demand):
- `${LIBRARY_DIR}/_bridge-cache`, `${LIBRARY_DIR}/_bridge-derived-cache` (`bridge-library-files.ts`).
- `hms-codes.json` (`hms-codes.ts`).
- In-memory only: `MemoryLruCache` (3MF parser), `import-store` (staged editor imports, LRU+TTL).

Ephemeral temp/work (per-operation; should not survive the operation):
- API: `slicer-client.ts`, `editor.ts`, `slicing-jobs.ts` (×3), `print-dispatcher.ts`,
  `printer-storage-3mf.ts` (×2), `admin-plugins.ts` + `printers.ts` (multer dest).
- Bridge: `runtime.ts` (×2), `packages/bridge-runtime/printer-ftp.ts`.
- Slicer service: `SLICER_WORK_DIR` (`/tmp/printstream-slicer`) + bambustudio home/data.

Hidden (generated-but-unpromoted artifacts):
- `libraryFile.hidden = true` sliced outputs awaiting save/print/discard.

## Proposed structure

One configurable root per process, split three ways by lifecycle. Each app keeps its own root
(API on the cloud host, bridge + slicer next to the printers) but follows the same shape.

```
<PRINTSTREAM_DATA_DIR>/            # persistent — backed up, never auto-deleted
  library/  plugins/  bridge-releases/  state/
<PRINTSTREAM_CACHE_DIR>/          # regenerable — safe to wipe wholesale
  bridge-files/<bridgeId>/...     # was LIBRARY_DIR/_bridge-cache
  bridge-derived/<bridgeId>/...   # was LIBRARY_DIR/_bridge-derived-cache (indexes + thumbnails)
  hms-codes.json
<PRINTSTREAM_TMP_DIR>/            # ephemeral — per-operation, swept on startup + on a timer
  printstream-<area>-<rand>/      # every mkdtemp lands here with a consistent prefix
```

Defaults keep today's behavior when the vars are unset: `PRINTSTREAM_DATA_DIR=./data`,
`PRINTSTREAM_CACHE_DIR=./data/cache`, `PRINTSTREAM_TMP_DIR=${os.tmpdir()}/printstream`. In
Docker these map to a persistent volume (data), an optional throwaway volume or `tmpfs` (cache),
and `tmpfs` (tmp). All three resolved once in `env.ts`; no feature code reads `process.env` or
calls `os.tmpdir()` directly (matches the existing env rule in `apps/api/CLAUDE.md`).

## Helper API

A single module — `apps/api/src/lib/runtime-paths.ts` (mirrored in bridge/slicer as needed) —
owns path construction and lifecycle so call sites stop hand-rolling `mkdtemp(path.join(tmpdir(), …))`:

```ts
// Ephemeral: auto-prefixed under PRINTSTREAM_TMP_DIR; the handle cleans itself up.
using work = await createTempDir('slice-arrange')   // .path, asyncDispose -> rm(recursive)
// Regenerable: namespaced under PRINTSTREAM_CACHE_DIR.
const p = cachePath('bridge-derived', bridgeId, basename)
```

- `createTempDir(area)` — `mkdtemp` under `PRINTSTREAM_TMP_DIR` with prefix `printstream-${area}-`,
  returning a disposable handle (works with `await using`) so the dozen current `try/finally { rm }`
  blocks collapse to one pattern and can't leak on an early return.
- `cachePath(namespace, ...segments)` — joins under `PRINTSTREAM_CACHE_DIR`; the only place that
  knows the cache root, so `bridge-library-files.ts` and `hms-codes.ts` stop embedding `_`-prefixed
  dirs in `LIBRARY_DIR`.
- `sweepTempDirs()` — on startup, remove `printstream-*` temp dirs older than a threshold (reclaims
  crash-orphaned work dirs); scheduled hourly thereafter.
- `pruneCache(maxAgeMs)` — extends the existing `pruneDerivedCacheDirectory` to every cache namespace.

## Hidden files as a first-class lifecycle

Keep `hidden` as the DB flag (location stays bridge-owned next to real files — moving bytes is
unnecessary and risks the overwrite/version logic), but give it a janitor:

- A periodic sweep deletes `hidden = true` library files older than a TTL (e.g. 6h) whose owning
  slicing job no longer exists — generalizing `discardHiddenSlicedOutput` from "on dialog close" to
  "also on a timer," so a crashed/closed client never strands an artifact.
- Document the contract: `hidden` means *generated, not yet promoted by the user*; promotion
  (`save`) clears it, discard/janitor deletes it. A new file is never born hidden unless it is such
  an artifact.

## Migration (incremental, no big-bang)

1. Add the three env vars + `runtime-paths.ts`; resolve roots in `env.ts`. No behavior change.
2. Move the bridge caches + hms-codes to `PRINTSTREAM_CACHE_DIR` via `cachePath`; on startup, if the
   old `${LIBRARY_DIR}/_bridge-*` dirs exist, delete them (caches regenerate) — no data migration.
3. Convert temp call sites to `createTempDir(area)` one module at a time (behavior-preserving).
4. Add `sweepTempDirs()` + the hidden-file janitor with focused regression tests (per
   `apps/api/CLAUDE.md`: cleanup/retention changes ship with tests).
5. Update Docker compose to mount cache as throwaway/`tmpfs` and point `PRINTSTREAM_TMP_DIR` at
   `tmpfs`; document the vars in `.env*.example`.

## Open questions for review

- Should the **cache** be per-tenant-scoped on disk, or is the current bridge/global split enough?
- TTLs: temp sweep age, hidden-file TTL, cache max-age — pick concrete numbers.
- Slicer service: fold `SLICER_WORK_DIR` into the same `PRINTSTREAM_TMP_DIR` convention, or keep it
  separate because BambuStudio also needs a persistent home/data dir there?
