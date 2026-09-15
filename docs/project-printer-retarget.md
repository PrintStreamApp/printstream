# Project printer retarget ("Save as a different printer")

## What this is

Changing the **printer a 3MF project targets** (e.g. opening an A1 mini project, switching the
printer to H2D, and saving), so the saved project opens and slices for the new machine. PrintStream
does this **by rewriting the project's machine settings, not by re-slicing**, so the user's relative
layout, arrangement, and filament selection are preserved. When the bed centre changes, every
plate's contents are translated by the same centre delta. They are never scaled or re-arranged.

The slicer's *cross-model machine switch* (`docs/slicer-cross-model-machine-switch.md`) is the
**slice-time** twin of this operation: it applies the same `retargetProjectSettingsToMachine`
rewrite to the slice input (plus a bed re-center for larger targets) before the CLI runs, so
PrintStream, not the BambuStudio CLI, is the source of truth for machine changes in both flows.

## How it works

Entry point: the editor's save (`apps/api/src/routes/editor.ts`) calls
`retargetSavedProjectMachine` (`apps/api/src/lib/save-retarget.ts`) when the save request carries a
`retarget` target (the web sends one when the selected machine is cross-model with the source, and
**always for a project with no source machine**: a new-project scaffold embeds no
`project_settings.config`, so its first save must persist the chosen machine this way; such a
project retargets from an empty settings object, the machine/process profiles supplying every field).

### Three machine paths, not one

The full retarget above runs only when the project's embedded machine does not already describe the
target MODEL. Two narrower paths cover the rest, both in `apps/api/src/routes/editor.ts`:

- **A machine PRESET change on the same model** (an H2D variant, a nozzle size, a user's own tuned
  machine) goes through `applyMachinePresetChange`, which authors the machine ONLY: no process
  re-resolve, no filament rebind. That is deliberate, and it is why this path exists separately -
  re-running the full retarget for a same-model switch would overwrite the user's process settings,
  which is why the branch used to do nothing at all and silently dropped the user's pick.

  It fires when the user actually PICKED the preset (`SlicingManualProfileTarget.printerProfileChosen`,
  set from the resolver's `origins.printerProfileId === 'user'`) or when the embedded machine no
  longer carries the target's nozzle diameters. Provenance is load-bearing: the client always sends a
  resolved `printerProfileId`, and for a project naming a preset this workspace does not hold that
  resolution FALLS BACK to the first catalogue profile matching the model. Treating "the name
  differs" as "the user switched" re-authored every such project onto a stock preset on an ordinary
  save, discarding its start G-code, accelerations and limits.

- **The project's OWN machine overrides** (`machineSettingOverrides`) are applied LAST, after
  whichever branch above authored the machine, by `applyMachineOverridesToProject`. They and the
  preset write the same keys, so any earlier position would let the preset overwrite the user's
  values. See the machine-override section of `docs/slicer-architecture.md`.

Steps for the full retarget:

1. **Resolve the target machine profile.** `slicerClient.resolveMachineConfig` → the slicer's
   `POST /profiles/resolve` with `kind: 'machine'`, which merges the preset's `inherits`/`include`
   chain into a flat config map. *This is a data lookup, not slicing.* If it can't be resolved the save
   **fails with a clear error**: it never silently keeps the source machine.
2. **Rewrite the machine settings.** `retargetProjectSettingsToMachine`
   (`packages/shared/src/machine-retarget.ts`):
   - **Overwrites every key the resolved machine profile defines** (minus profile metadata such as
     `name`/`type`/`inherits` and compatibility declarations). The profile *is* the definition of
     "machine-owned settings", so this is generic and complete: bed, nozzle, extruder topology,
     machine gcode, accel/jerk limits, etc.
   - Sets `printer_settings_id` / `printer_model` to the target.
   - Re-derives the runtime maps that depend on **both** the new machine topology and the project's
     filaments: `filament_nozzle_map`, `filament_volume_map`, `printer_extruder_variant`,
     `filament_extruder_variant`, `extruder_nozzle_stats`, `extruder_ams_count`
     (`repairEstimateModeProjectSettings`, shared with the slicer's topology repair).
3. **Bring the process over.** `applyProcessProfileToProjectSettings` resolves the selected target
   process preset (`resolveProcessConfig`) and overwrites the process-owned keys + `print_settings_id`,
   then applies the user's per-slice process overrides on top. Process keys are disjoint from machine
   keys, so this composes cleanly after step 2. **Best-effort**: if the process can't be resolved (e.g.
   a project-embedded preset), the machine retarget still stands.
4. **Write it back** into the 3MF (`rewriteThreeMfEntries` targeting `project_settings.config`,
   an upsert: the entry is appended when the settings-less source has none to transform), copying
   every other entry verbatim.

### Two hosts, one rewrite

The steps above describe the **workspace editor**, where the API bakes the save. The **public 3MF
editor** (`/3mf-editor`) performs the same operation entirely in the browser (the user's file never
leaves the tab), and it must produce the same file, so the DECISIONS are shared and only the I/O
differs:

| Piece | Shared | Workspace host | Public host |
| --- | --- | --- | --- |
| What a retarget rewrites, and in what order | `applyMachineRetargetToProjectSettings` (`packages/shared/src/machine-retarget.ts`) | n/a | n/a |
| Which preset each filament slot rebinds to | `selectFilamentRebindTargets` (`packages/shared/src/filament-rebind.ts`) | n/a | n/a |
| Dropping the stale slice identity | `stripSliceInfoPrinterModelId` | n/a | n/a |
| Resolving the machine / process / filament presets | n/a | `slicerClient` + the workspace's preset files (`save-retarget.ts`) | `POST /api/public/slicing/resolve-{machine,process,filament}` (`lib/localMachineRetarget.ts`) |
| Applying it to the 3MF | n/a | post-bake ZIP rewrite (`rewriteThreeMfEntries`) | post-bake entry rewrite in the tab (`lib/clientThreeMfBake.ts`) |

Both run the rewrite in the **same position**: after the bake, before the archive is written. The one
step that cannot move into the browser is resolving the target machine's preset: that data lives in
the slicer image, hence the anonymous `resolve-machine` route, which is **built-in presets only**
(a custom preset is workspace data by definition).

Failure posture differs by host and deliberately so: the workspace save **fails loudly** if the
machine cannot be resolved (see Failure modes), while the public editor **warns to the console and
saves without the retarget**: it has no server-side transaction to abort, and losing the user's only
copy of the file to a failed save would be far worse than losing the printer switch.

### What carries over (and what doesn't)

| Aspect | Behavior on retarget |
| --- | --- |
| **Machine** (bed, nozzle, extruder topology, gcode, limits) | Replaced with the target machine's (step 2). |
| **Process** (layer height, walls, speeds, `print_settings_id`) | Replaced with the target's process preset + user overrides (step 3). With no preset chosen, a CROSS-MODEL retarget keeps the project's own **only while it still fits the target**: its parent (`inherits_group[0]`) is looked up and, if that preset does not list the target machine, the machine's `default_print_profile` is authored instead. A same-model preset change (a nozzle switch) never reselects. See "Why a process can be switched without being chosen" below. |
| **Filaments** (selection, colours) | Preserved. The editor's save already embeds the user's assigned (target-compatible) filaments via `applyFilamentList`; the retarget leaves `filament_settings_id`/`filament_colour` untouched. The per-extruder *map* is re-derived for the new topology (step 2). |
| **Layout** (object positions, plates, paint, parts, brim ears) | Preserved relative to each plate. Objects and the prime tower translate by the bed-centre delta, without scaling or re-arranging. `SceneEdit.placementBedSize` makes the bake author the global multi-plate grid with the target bed stride. |
| **Printer-compatibility declarations** (`print_compatible_printers` / `compatible_printers`, slice_info `printer_model_id`) | Re-declared for the target so the project's compatibility chips read as the new printer only. The source printer's declarations aren't machine settings (so the field-set overwrite skips them) and the embedded slice was for the old printer: both would otherwise linger as stale chips (an A1/A1 mini chip on an H2D project). The save sets `print_compatible_printers`/`compatible_printers` to the target and strips the stale slice_info `printer_model_id` (matching a BambuStudio saved-not-sliced project). |

### Coverage

Every Bambu machine the slicer has a profile for is supported automatically: there is **no
per-model code**. The set of machines is whatever lives in the slicer image's `machine_full/`
directory (see below).

### Triggers and known limitations

The web (`LibraryView` `retargetTarget`) builds a retarget only when the selected machine's **canonical
model** differs from the project's source model, or when the project has **no source model at all**
(a new-project scaffold), so a same-model save never round-trips the slicer.
Consequences to be aware of:

- **Same model, different nozzle** (e.g. X1C 0.4 → X1C 0.6): not currently retargeted. The saved
  project keeps the source nozzle's machine. Switching to a different *model* always retargets.
- **Cross-model with a project-embedded process** (e.g. P1S → X2D where the process is the 3MF's
  own preset): the embedded process has no separate file to resolve, so nothing is *chosen*. The
  project's own is kept when its parent still accepts the target and replaced with the machine's
  `default_print_profile` when it does not (below). It was previously kept unconditionally, on the
  assumption that these presets are cross-compatible within a family; that is false across families
  and produced files that opened correctly and could not be sliced at all.
- **Smaller target bed**: the arrangement is re-centred but not scaled or packed, so objects authored
  for a larger bed may still land out-of-bounds. The user must then re-arrange them.

### Failure modes

- Slicer unavailable / machine preset unresolvable → save fails with a 409 and a clear message
  (no corruption, source file untouched).
- Process preset unresolvable → machine retarget still applied (the project is still openable/printable
  on the new machine); the process keeps the source preset.
- Process **parent** unresolvable, or no compatible replacement → the project keeps its own process,
  i.e. exactly the pre-existing behaviour. A lookup miss is "unknown", never "wrong", so the switch
  below can never make a save worse than it was.

### Why a process can be switched without being chosen

The machine rewrite re-declares `print_compatible_printers` for the target, and the engine **does not
read that field** when it decides whether a project may slice. It resolves the process preset's
parent (`inherits_group[0]`, else `print_settings_id`), loads that system preset, and takes its
`compatible_printers` as the project's compatibility, overwriting whatever the file declared
(`BambuStudio.cpp:2760-2776`, and again at `:2890-2906`). If the target machine is absent from that
list it exits 239, `CLI_PROCESS_NOT_COMPATIBLE`.

A machine-only retarget leaves that parent naming the OLD model. The result opens fine, draws the
right compatibility chips, and cannot be sliced by the printer it claims to be for. Found on prod on
7 September 2026: a P1P-lineage project retargeted onto an X2D failed eighteen consecutive slices.

`resolveRetargetProcessFallback` (`packages/shared/src/machine-retarget.ts`) is the fix, and it is
BambuStudio's own behaviour rather than an invention. Studio never repoints a preset's lineage: on a
printer change `PresetBundle::update_compatible(Always)` recomputes every process preset's
compatibility, deselects the current one if it no longer fits (`Preset.cpp:2999-3003`), and selects
another, seeded with the new printer's `default_print_profile` (`PresetBundle.cpp:5741`). The user's
preset survives untouched and simply stops being offered.

It runs on the CROSS-MODEL path only (`buildMachineRetargetPlan` and the API's
`retargetSavedProjectMachine`), never on the same-model preset change. That branch's contract is
"author the machine, leave the process alone", and reselecting there would overwrite every process
key on an ordinary nozzle change, discarding values the user tuned by hand in an earlier session.
It is also unnecessary: a machine-preset change re-picks the process in the dialog, so a process
that no longer fits arrives at the save already replaced.

Two deliberate narrowings versus Studio:

- Studio scans the whole catalogue and prefers a matching **alias**, then a matching `layer_height`,
  over the machine default. We take the machine's declared default only: the alias is not
  recoverable (the generated `process_full/` profiles carry none), and a save is not the place to
  change layer height by a catalogue scan. The **slice dialog's** re-pick does own the layer-height
  preference (`useProcessProfileSelection`), and on any path through it the process is already
  compatible, so the fallback never fires.
- Nothing happens unless both lookups succeed and the replacement itself fits.

The dialog is the other half of the same fix, and the load-bearing half. A `project:` process preset
carries only a name, so a renamed one ("0.20mm Speed - Tablet Mount") declared nothing and read as
compatible with every printer. The 3MF index now reports `processProfileInherits`, the browser
carries it on the project preset as `derivedFromPresetName`, and `isProcessProfileCompatible`
resolves that parent in the installed catalogue and judges its real `compatible_printers` rather
than its name. Reading the name alone is not enough: `compatible_printers` is nozzle-specific
("0.20mm Strength @BBL P1P" lists only `Bambu Lab P1P 0.4 nozzle`) while the name mentions no
nozzle, so a 0.4 to 0.6 switch on the same model passed every name rule and still failed the slice.
A parent that is not installed falls back to the name rules, because unknown is not a mismatch.

So the picker drops such a preset on a machine switch and re-picks a compatible one, which makes the
save choose a process and the retarget fallback never fire. Existing files stay as they are until
they are re-saved; nothing heals at rest.

## Where machine profiles come from

The resolver reads the BambuStudio system presets bundled in the **slicer image**:

- `apps/slicer/docker/slicer-targets.mjs` pins the BambuStudio AppImage version(s) (`version` +
  `downloadUrl` per target).
- At image build, `install-slicer-targets.mjs` downloads each AppImage and runs
  `generate-bambustudio-full-profiles.mjs`, which flattens BambuStudio's bundled presets into
  `machine_full/`, `process_full/`, `filament_full/` JSON under each target's `profileDir`. The
  flattener merges **both** the `inherits` chain **and** each preset's `include` templates. The
  latter is load-bearing for machines: BambuStudio keeps every machine's real
  `machine_start_gcode` / `machine_end_gcode` / `change_filament_gcode` / `layer_change_gcode` /
  `time_lapse_gcode` / `wrapping_detection_gcode` in per-machine `… template <key>` profiles pulled
  in via `include`, while the `inherits` chain carries only a GENERIC single-nozzle fallback. If the
  flattener skipped includes, a retarget (and slice) would bake the generic prime-line start gcode
  onto every printer, so e.g. an H2D project would start with an A1-style edge prime and the correct
  nozzle would never be primed/extrude.
- `POST /profiles/resolve` (`apps/slicer/src/index.ts`) reads `<kind>_full/<name>.json` and resolves
  the inherits chain via `resolveCustomProfileConfig`.

So the available machines (and their fields) track the pinned BambuStudio version.

## Keeping up with BambuStudio updates

When BambuStudio releases a new version we want to support:

1. **Bump the pin** in `apps/slicer/docker/slicer-targets.mjs` (`version` + `downloadUrl`; add a new
   target entry, or update an existing one).
2. **Update licensing/version mirrors** (per the slicer development notes): the table in
   `apps/slicer/THIRD-PARTY-SLICERS.md` and the mirror list in
   `apps/web/src/private/cloud/OpenSourceLicensesPage.tsx`.
3. **Regenerate the slicing presets**: in dev, re-bootstrap the in-workspace slicer (delete
   `~/.printstream-slicer` and `npm run dev`, or re-run the generator per the slicer development notes);
   for staging/live, republish the ghcr image via the public repo's CI. This regenerates
   `machine_full/` from the new AppImage, so new machines and new machine fields appear automatically.
4. **Verify the retarget** (below) for at least one single-extruder→multi-extruder switch.

### What is and isn't resilient to BambuStudio changes

- **Resilient (no maintenance):** the machine field-set overwrite is **profile-driven**. It copies
  whatever keys the resolved profile contains, so new/renamed machine settings are carried over with
  no code change.
- **Coupled to BambuStudio (maintenance + verification):** the dependent-map derivation in
  `machine-retarget.ts` (`repairEstimateModeProjectSettings` and its helpers: extruder variants,
  `filament_nozzle_map`, nozzle-volume indices, AMS counts). If BambuStudio changes how multi-extruder
  topology or nozzle-volume types are encoded, this derivation must be updated. The verification below
  is the safety net: it fails loudly (bad slice) when the derivation drifts.

## Verifying after a change

Against a source-built slicer (development container):

1. Retarget a single-extruder project to a multi-extruder machine (e.g. an A1 mini project → H2D) via
   the editor's "switch printer + Save", or by calling `retargetSavedProjectMachine` directly.
2. Confirm the saved 3MF **opens** in the editor (the model renders, i.e. it is a project, not sliced
   output) and that its `project_settings.config` has the target's `printer_model`,
   `printer_settings_id`, **and `print_settings_id`** (process carried over).
3. Confirm it **slices**: run a normal slice of the retargeted project and check for a non-zero, valid
   `.gcode.3mf` (no `filament … not compatible with printer`, no exit 251/segfault).

`data/verify-slice-fix.mjs` (dev, gitignored) does this end-to-end against the sidecar.

Cover at least: A1 mini / A1 (single extruder) and H2D / H2D Pro (dual extruder); a same-family
control (e.g. P1S → X1C) should also slice. Unit coverage for the pure rewrite lives in
`packages/shared/src/machine-retarget.test.ts`.
