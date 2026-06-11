# Slicer (apps/slicer)

Applies when working in the standalone slicer service that wraps the BambuStudio/OrcaSlicer CLI.

`@printstream/slicer` is a small HTTP service that turns a 3MF plus chosen profiles into sliced output (`.gcode`, `.gcode.3mf`, or `.3mf`). It runs as its own process/container, is invoked by the API over HTTP, and holds no database or tenant state. It is Bambu/Orca-CLI-specific.

## What lives here

- `index.ts` — the HTTP server and slice pipeline: resolve/materialise profiles, rewrite the input 3MF, spawn the slicer CLI (`SLICER_CLI_ARGS_TEMPLATE`), and package the output. The server raises `maxHeaderSize`; keep it — multi-material slices send large headers and lowering it reintroduces HTTP 431.
- `output-metadata.ts` — rewrites the embedded `project_settings.config` / `slice_info.config` of the **input** 3MF *before* slicing, so its edits shape the gcode. Read the invariant below before touching it.
- `machine-switch-repair.ts` + `machine-switch-guard.ts` — the cross-model "estimate-mode" machine-switch path (slice a project authored for printer A onto printer B). See `docs/slicer-cross-model-machine-switch.md`; the guard rejects unsupported combinations instead of emitting a bad slice.
- `all-plate-fallback.ts` — merge per-plate slices into one all-plate export for models that need it.
- `cli-profile-selection.ts`, `custom-profile-resolve.ts`, `profile-*.ts`, `slicer-targets.ts` — resolve machine/process/filament presets (built-in, project-embedded, and custom) into CLI `--load-settings`/`--load-filaments` args.
- `env.ts` — all config (`SLICER_PORT`, `SLICER_CLI_ARGS_TEMPLATE`, work/home dirs, service token). Read env through here, not `process.env`, in feature code.

## Nozzle-mapping invariant (do not re-break)

`output-metadata.ts` writes `filament_nozzle_map` **verbatim** as a runtime nozzle id (0 = right, 1 = left) — the same space the index parser `apps/api/src/lib/three-mf-reader.ts` (`extractNozzleMapping`) canonicalises every BambuStudio quirk into. The read path and this write path must stay inverse-free mirrors: do **not** remap the value through `physical_extruder_map`. A second remap double-inverts the assignment on machines whose map is non-identity (e.g. the H2D's `["1","0"]`), forcing a filament onto the wrong nozzle and failing dual-nozzle offset calibration (printer error `0300-4010`). Likewise `printer_model` is written as Bambu's per-model preset name string (e.g. `"Bambu Lab H2D"` — the machine preset name minus its nozzle-size suffix), not our internal short code. Cover any change here with a round-trip test asserting an unchanged source's `filament_nozzle_map` survives slicing byte-for-byte.

## Licensing (AGPL slicer engines)

The bundled slicer engine (Bambu Studio, and OrcaSlicer if added) is **AGPL-3.0**. It is downloaded unmodified and invoked as a separate process, so PrintStream's own code is not a derivative — but the binaries are redistributed in the image and their slicing is offered over the network, so the attribution + corresponding-source offer in `apps/slicer/THIRD-PARTY-SLICERS.md` must accompany them (the Dockerfile copies it into `/app/licenses`). **If you change the bundled versions in `docker/slicer-targets.mjs`, update the version/source table in `THIRD-PARTY-SLICERS.md` and the mirror list in `apps/web/src/pages/OpenSourceLicensesPage.tsx` to match.** If the engine is ever patched, publish the modified source, not just the upstream tag.

## Build and validation

- Tests are colocated `*.test.ts` in the repo's Node suite; run `npm run validate` from the repo root.
- In the dev compose stack the `slicer` service runs the prebuilt `printstream-staging-slicer:latest` image (no source mount, no `build:` directive), so editing `apps/slicer/src` does **not** hot-reload the running slicer, and a normal `docker compose up --build` deploy does **not** rebake it — a merged slicer fix stays dormant in the live container until its image is rebuilt, which can look like a regression. Rebuild + recreate it with `npm run deploy:slicer:ssh` (or `deploy:slicer:staging:ssh`, or `--local` on the box); see `scripts/deploy/rebuild-slicer-over-ssh.mjs`. The Node test suite runs against source, so unit/regression tests still cover edits without a rebuild.
