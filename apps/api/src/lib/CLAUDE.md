# apps/api/src/lib — domain guides

Most cross-cutting backend contracts live here. Read the guide that matches the file you are editing:

- `auth*.ts`, `authorization.ts` → `.claude/guides/auth-architecture.md`
- `ws*.ts`, `*event*.ts`, `auth-context.ts` → `.claude/guides/data-event-contract.md`
- `printer*.ts`, `mqtt*.ts`, `camera*.ts`, `print-dispatcher.ts`, `printer-discovery.ts` → `.claude/guides/printer-driver-migration.md`
- Anything else here → `.claude/guides/backend-conventions.md` (thin routes, tenancy, `HttpError`, rate limits, durable stats).

## The `three-mf` modules

`three-mf.ts` is a re-export **barrel**; the implementation lives in four focused modules with
one-way dependencies (output/scene-builder → reader → internal, so no import cycle):

- `three-mf-internal.ts` — shared scaffolding: ZIP I/O (`readEntry`/`readZipEntryBuffer`), abort
  helpers, XML/regex escaping, and the generic `rewriteModelSettingsThreeMf` copy pass.
- `three-mf-reader.ts` — parse a 3MF into typed index/scene structures (`readPlateIndex`,
  `readSceneManifest`). **This is the bridge-mirrored half** (see below).
- `three-mf-scene-builder.ts` — bake an editor `SceneEdit` into a 3MF (`buildEditedThreeMf`).
- `three-mf-output.ts` — slice-ready 3MF variants (`createSinglePlateThreeMf` and friends,
  `embedPlateThumbnails`) and reading sliced gcode/pick output (`readPlateObjectsWithPreview`).

Keep imports flowing one way; new code should import from the focused module, not the barrel.

## 3MF index parsing is duplicated (read before editing `three-mf-reader.ts`)

Library files are **bridge-owned by default** (local, non-bridge files are an unsupported fallback). So the 3MF index the web normally sees is produced on the bridge by `apps/bridge/src/library-3mf.ts` via the `library.inspect3mf` RPC — a hand-kept **mirror** of `three-mf-reader.ts`. The api modules only run for the local-copy/fallback parse (`three-mf-reader.ts`) and for slice-time 3MF rewriting (`three-mf-scene-builder.ts`, `three-mf-output.ts`).

When you change the parsed 3MF **index shape** (e.g. add a per-plate field like `objects`):
1. Apply the change in **both** `apps/api/src/lib/three-mf-reader.ts` and `apps/bridge/src/library-3mf.ts`.
2. Add the field to the shared schema (`bridgeLibraryThreeMfIndexSchema` / `threeMfPlateSchema`) — Zod strips anything the schema omits, silently dropping new fields.
3. Bump **both** `THREE_MF_PARSER_CACHE_VERSION` constants and `BRIDGE_LIBRARY_DERIVED_CACHE_VERSION` in `bridge-library-files.ts`, or stale cached indexes will be served.
