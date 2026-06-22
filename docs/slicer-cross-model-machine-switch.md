# Slicer Cross-Model Machine Switch

## What this covers

How the slicer service retargets a 3MF authored for one Bambu printer onto a
*different* printer model at slice time, and why that path is split in two:

- a **standard single-pass** slice for same-model jobs, and
- a **two-pass estimate-mode** slice for cross-model jobs that land on an
  H2-family multi-extruder machine.

If you are tempted to collapse these into one CLI invocation, read the
"Why the split exists" section first — the split is a workaround for a hard
BambuStudio CLI crash, not an accident.

> This is the **slice-time** retarget (it produces gcode). To change the printer a saved
> **project** targets without slicing — a pure settings rewrite that preserves the layout —
> see `docs/project-printer-retarget.md`. The two share the topology-repair math in
> `packages/shared/src/machine-retarget.ts`.

## The two paths

Both paths run from `runCli` in [apps/slicer/src/index.ts](../apps/slicer/src/index.ts).

### Standard path (same model, or no embedded source model)

Used when the target printer model equals the model baked into the source 3MF,
or the source carries no model. `prepareInputThreeMf` rewrites the embedded
project settings, and `selectCliProfileFiles`
([apps/slicer/src/cli-profile-selection.ts](../apps/slicer/src/cli-profile-selection.ts))
deliberately drops the machine profile because the embedded 3MF already carries
the correct machine identity. One `--slice --load-settings <process>` call
produces the output.

### Estimate-mode path (cross-model into an H2-family machine)

Selected by `shouldUseEstimateModeMachineSwitch`
([apps/slicer/src/machine-switch-guard.ts](../apps/slicer/src/machine-switch-guard.ts))
when all of the following hold:

- the source 3MF carries project settings,
- the CLI advertises `--estimate-mode`, and
- the resolved target model differs from the resolved source model.

`assertSupportedEmbeddedMachineSwitch` additionally hard-fails a cross-model
switch *into* `H2D` / `H2DPRO` / `H2C` when `--estimate-mode` is unavailable,
because those targets cannot be reached any other way.

The path runs three steps in `runEstimateModeMachineSwitch`:

1. **Estimate export** — `--estimate-mode --export-3mf machine-switch-estimate.3mf`
   (no `--slice`). BambuStudio performs the authoritative machine switch:
   rewrites `printer_model`, `nozzle_diameter`, and the H2 extruder variants,
   and (because we still pass `--load-filaments`) keeps the real filament colors
   rather than the 8-slot estimate placeholders.
2. **Repair** — `repairEstimateModeProjectSettings`
   ([apps/slicer/src/machine-switch-repair.ts](../apps/slicer/src/machine-switch-repair.ts))
   reconciles the multi-extruder topology that the estimate export leaves
   inconsistent (e.g. `extruder_max_nozzle_count` vs `nozzle_volume_type` length,
   empty `extruder_ams_count` slots), pulling the missing fields from the merged
   machine profile (`mergeInheritedMachineProfile`). The result is written to
   `machine-switch-repaired.3mf`.
2b. **Re-center onto a larger bed** — `recenterRepairedProjectForLargerBed`
   ([apps/slicer/src/recenter-plates.ts](../apps/slicer/src/recenter-plates.ts)).
   BambuStudio's CLI only auto-recenters objects (`translate_models`) on a switch it
   treats as *forced* — i.e. an **incompatible** process — not the compatible-process
   switch this flow performs. So on a switch to a **larger** bed the objects keep the
   source bed's per-plate global offsets, and a multi-plate project's non-first plates
   fall outside their plate region → `CLI_NO_SUITABLE_OBJECTS` (exit 206). We apply
   BambuStudio's own per-plate shift ourselves (derived from `compute_origin_using_new_size`
   + `translate_models`, `GAP = 1/5`), reading the source bed from the original upload and
   the target bed from the merged machine profile. A no-op for a same/smaller target bed.
3. **Final slice** — `--slice` the re-centered repaired 3MF with no profile args; its
   machine identity is now embedded and self-consistent.

## Why the split exists

A cross-model slice from a single-extruder source (e.g. P1S) onto an H2-family
multi-extruder machine was tested directly against BambuStudio CLI v02.07.00.55.
Every single-pass alternative crashes:

| Approach | Result |
| --- | --- |
| `--slice --load-settings <H2D machine>;<H2D process> --load-filaments ...` (machine profile kept, no estimate-mode) | Segfault (`get_extruder_variant_string, unsupported ExtruderType=<garbage>`) |
| `--slice --estimate-mode --load-settings ...` (one-shot estimate + slice) | Segfault |
| `--estimate-mode --export-3mf ...` (no `--slice`) | Succeeds; produces a retargeted but topology-inconsistent 3MF |
| `--slice <estimate export>` without the repair step | Segfault (`no filament colors found in projects`) |

So:

- A naive single `--slice` cannot perform the cross-model switch into an H2
  multi-extruder machine — it crashes inside extruder-variant resolution.
- A one-shot `--slice --estimate-mode` also crashes, and estimate-mode is an
  *estimation* mode anyway: on auto filament-map it fabricates eight white
  placeholder AMS slots, which must not be baked into a printable gcode.3mf.
- Only the estimate **export** survives the machine switch, and the export alone
  is not sliceable — the TypeScript repair is load-bearing.

Both halves of the two-pass design are therefore required. There is no known
single-CLI invocation that produces a correct cross-model H2 slice.

## Maintenance notes

- Keep `shouldUseEstimateModeMachineSwitch` and the H2 guard in sync with the
  set of multi-extruder models; today that is `H2D` / `H2DPRO` / `H2C`.
- `machine-switch-guard.ts` has a local `normalizePrinterModel` that overlaps
  with `canonicalBambuModelKey` in the web app
  ([apps/web/src/lib/bambuPrinterModels.ts](../apps/web/src/lib/bambuPrinterModels.ts)).
  Consider consolidating if the model-key logic is ever moved into
  `packages/shared`.
- Before changing either path, re-run a real cross-model job (single-extruder
  source onto H2D) and confirm a non-zero, non-segfault exit and a valid
  output 3MF. The crash modes above are silent (exit 139) and easy to
  reintroduce.
