# Slicer Cross-Model Machine Switch

## What this covers

How the slicer service retargets a 3MF authored for one Bambu printer onto a
*different* printer model at slice time (e.g. slicing a P1S project for an X2D
without saving it first).

**PrintStream is its own source of truth for 3MF machine changes.** A
cross-model slice does NOT round-trip the BambuStudio CLI to switch machines:
the input 3MF's `project_settings.config` is rewritten natively with the shared
`retargetProjectSettingsToMachine` (`packages/shared/src/machine-retarget.ts`)
— the exact rewrite the editor's "save as a different printer" flow uses
(`docs/project-printer-retarget.md`) — and the CLI then slices a project that
already natively targets the requested machine, on the ordinary single-pass
path. This works on every bundled slicer version; there is no dependency on
CLI capability flags.

## The flow

Everything happens in `prepareInputThreeMf` in
[apps/slicer/src/index.ts](../apps/slicer/src/index.ts), before the CLI runs:

1. **Detect the switch** — `shouldRetargetEmbeddedMachine`
   ([apps/slicer/src/machine-switch-guard.ts](../apps/slicer/src/machine-switch-guard.ts))
   compares the request's target model (the machine profile / `printerModel`)
   with the project's embedded model (`printer_model` / `printer_settings_id`),
   both canonicalised via the shared `canonicalBambuModelKey`
   (`packages/shared/src/bambu-model-keys.ts`). No switch → the standard
   prepare/rewrite path runs unchanged.
2. **Retarget natively** — the project-settings transform applies
   `retargetProjectSettingsToMachine` with the fully-merged target machine
   profile (`readMergedMachineProfile` over the flattened `machine_full/`
   presets): every machine-owned key is overwritten, the printer identity and
   compatibility declarations are set to the target, the topology-dependent
   runtime maps (`filament_nozzle_map`, extruder variants, AMS counts, …) are
   re-derived, and the stale machine slot of `inherits_group` is blanked (the
   CLI resolves the project's SYSTEM printer from that slot — see below). The
   ordinary identity/filament rewrite (`rewriteProjectSettingsMetadata`) runs
   on top, so the request's process/filament choices land as usual.
3. **Re-center onto a larger bed** — `recenterRepairedProjectForLargerBed`
   ([apps/slicer/src/recenter-plates.ts](../apps/slicer/src/recenter-plates.ts)).
   The retarget preserves the source layout, and BambuStudio's CLI only
   auto-recenters objects on a switch it treats as *forced* — so on a switch to
   a **larger** bed a multi-plate project's non-first plates would fall outside
   their plate regions (`CLI_NO_SUITABLE_OBJECTS`, exit 206). We apply
   BambuStudio's own per-plate shift ourselves (derived from
   `compute_origin_using_new_size` + `translate_models`, `GAP = 1/5`). A no-op
   for a same/smaller target bed.
4. **Slice normally** — the standard single-pass CLI invocation. Because the
   project settings were rewritten, `selectCliProfileFiles` drops the machine
   profile from `--load-settings` (the embedded 3MF is the machine identity);
   the process and filament presets load as usual and validate against the
   *new* machine.

## Why the machine profile is dropped from `--load-settings`

Loading a machine preset alongside a project was tested directly against
BambuStudio CLI v02.07.00.55 and crashes on cross-model multi-extruder input
(`get_extruder_variant_string, unsupported ExtruderType=<garbage>` segfault).
The retargeted 3MF makes the load unnecessary: its embedded machine identity
and topology are already self-consistent — the same reason a project saved via
"save as a different printer" slices cleanly afterwards.

## Why the `inherits_group` blank matters

BambuStudio resolves the project's *system* printer from the machine (last)
slot of `inherits_group`, not from `printer_settings_id`. A project saved with
an inherited/custom machine preset keeps its old parent there (e.g.
`Bambu Lab P1P 0.4 nozzle`), and CLIs from 2.7.1 on validate every loaded
filament preset against that name — so a stale slot fails the slice with the
misleading `filament preset … is not compatible with printer <old machine>`.
Both the slice-time rewrite (`rewriteProjectSettingsMetadata`) and the shared
retarget blank the relevant slots when they rewrite the corresponding
`*_settings_id`.

## The remaining guard

`assertSupportedEmbeddedMachineSwitch` hard-fails exactly one case a retarget
cannot help: a **nominally same-model H2-family project**
(`H2D` / `H2DPRO` / `H2C`) that lacks the H2 dual-nozzle topology
(`physical_extruder_map` et al.) — no switch is detected, so nothing rebuilds
the topology, and the CLI segfaults resolving extruder variants. The error
tells the user to re-save the project for that printer.

## Maintenance notes

- Model keys and the process-compatibility families live in
  `packages/shared/src/bambu-model-keys.ts` (`canonicalBambuModelKey`,
  `bambuModelKeysAreCompatible`), shared with the web slice dialog's profile
  matching — change them there, not in a consumer.
- The retarget math itself is `packages/shared/src/machine-retarget.ts`,
  shared with the API's save-retarget; see `docs/project-printer-retarget.md`
  for what carries over and how to verify after a BambuStudio version bump.
- Before changing this path, re-run a real cross-model job (single-extruder
  source onto H2D and onto X2D) and confirm a non-zero, non-segfault exit and
  a valid output 3MF. The CLI's crash modes are silent (exit 139) and easy to
  reintroduce.

## History

Until 2026-07 this path used BambuStudio's `--estimate-mode` export as pass 1
of a two-pass flow (CLI performs the switch, TypeScript repairs the topology,
then a second CLI pass slices). That made cross-model slicing dependent on the
selected slicer version exposing `--estimate-mode` — Bambu Studio 2.6.0.51
ships X2D presets but not the flag, so a P1S→X2D slice silently fell down the
standard path and failed with the filament-compatibility error above. The
native retarget (already proven by the save flow) removed both the CLI
round-trip and the capability dependency.
