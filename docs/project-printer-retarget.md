# Project printer retarget ("Save as a different printer")

## What this is

Changing the **printer a 3MF project targets** — e.g. opening an A1 mini project, switching the
printer to H2D, and saving — so the saved project opens and slices for the new machine. PrintStream
does this **by rewriting the project's machine settings, not by re-slicing**, so the user's layout,
arrangement, and filament selection are preserved exactly.

This is distinct from the slicer's *cross-model machine switch* (`docs/slicer-cross-model-machine-switch.md`),
which retargets **at slice time** as part of producing gcode. That path is a slicing operation and can
reshape machine-derived geometry (wipe tower, plate). The retarget here is a pure settings rewrite and
touches no geometry.

## How it works

Entry point: the editor's save (`apps/api/src/routes/editor.ts`) calls
`retargetSavedProjectMachine` (`apps/api/src/lib/save-retarget.ts`) when the save request carries a
`retarget` target (the web sends one when the selected machine is cross-model with the source, and
**always for a project with no source machine** — a new-project scaffold embeds no
`project_settings.config`, so its first save must persist the chosen machine this way; such a
project retargets from an empty settings object, the machine/process profiles supplying every field).
Steps:

1. **Resolve the target machine profile.** `slicerClient.resolveMachineConfig` → the slicer's
   `POST /profiles/resolve` with `kind: 'machine'`, which merges the preset's `inherits`/`include`
   chain into a flat config map. *This is a data lookup, not slicing.* If it can't be resolved the save
   **fails with a clear error** — it never silently keeps the source machine.
2. **Rewrite the machine settings.** `retargetProjectSettingsToMachine`
   (`packages/shared/src/machine-retarget.ts`):
   - **Overwrites every key the resolved machine profile defines** (minus profile metadata such as
     `name`/`type`/`inherits` and compatibility declarations). The profile *is* the definition of
     "machine-owned settings", so this is generic and complete — bed, nozzle, extruder topology,
     machine gcode, accel/jerk limits, etc.
   - Sets `printer_settings_id` / `printer_model` to the target.
   - Re-derives the runtime maps that depend on **both** the new machine topology and the project's
     filaments — `filament_nozzle_map`, `filament_volume_map`, `printer_extruder_variant`,
     `filament_extruder_variant`, `extruder_nozzle_stats`, `extruder_ams_count`
     (`repairEstimateModeProjectSettings`, shared with the slicer's topology repair).
3. **Bring the process over.** `applyProcessProfileToProjectSettings` resolves the selected target
   process preset (`resolveProcessConfig`) and overwrites the process-owned keys + `print_settings_id`,
   then applies the user's per-slice process overrides on top. Process keys are disjoint from machine
   keys, so this composes cleanly after step 2. **Best-effort**: if the process can't be resolved (e.g.
   a project-embedded preset), the machine retarget still stands.
4. **Write it back** into the 3MF (`rewriteThreeMfEntries` targeting `project_settings.config` —
   an upsert: the entry is appended when the settings-less source has none to transform), copying
   every other entry verbatim.

### What carries over (and what doesn't)

| Aspect | Behavior on retarget |
| --- | --- |
| **Machine** (bed, nozzle, extruder topology, gcode, limits) | Replaced with the target machine's — step 2. |
| **Process** (layer height, walls, speeds, `print_settings_id`) | Replaced with the target's process preset + user overrides — step 3. |
| **Filaments** (selection, colours) | Preserved. The editor's save already embeds the user's assigned (target-compatible) filaments via `applyFilamentList`; the retarget leaves `filament_settings_id`/`filament_colour` untouched. The per-extruder *map* is re-derived for the new topology (step 2). |
| **Layout** (object positions, plates, paint, parts, brim ears) | Preserved exactly — `model_settings.config` is copied verbatim, no re-arrange. |
| **Printer-compatibility declarations** (`print_compatible_printers` / `compatible_printers`, slice_info `printer_model_id`) | Re-declared for the target so the project's compatibility chips read as the new printer only. The source printer's declarations aren't machine settings (so the field-set overwrite skips them) and the embedded slice was for the old printer — both would otherwise linger as stale chips (an A1/A1 mini chip on an H2D project). The save sets `print_compatible_printers`/`compatible_printers` to the target and strips the stale slice_info `printer_model_id` (matching a BambuStudio saved-not-sliced project). |

### Coverage

Every Bambu machine the slicer has a profile for is supported automatically — there is **no
per-model code**. The set of machines is whatever lives in the slicer image's `machine_full/`
directory (see below).

### Triggers and known limitations

The web (`LibraryView` `retargetTarget`) builds a retarget only when the selected machine's **canonical
model** differs from the project's source model — or when the project has **no source model at all**
(a new-project scaffold) — so a same-model save never round-trips the slicer.
Consequences to be aware of:

- **Same model, different nozzle** (e.g. X1C 0.4 → X1C 0.6): not currently retargeted — the saved
  project keeps the source nozzle's machine. Switching to a different *model* always retargets.
- **Same-family cross-model with a project-embedded process** (e.g. X1C → P1S where the process is the
  3MF's own preset): the embedded process can't be resolved to a separate file, so it is kept as-is
  (these presets are cross-compatible within the family, so this is usually fine).
- **Smaller target bed**: positions are preserved, so objects authored for a larger bed may land
  out-of-bounds on a smaller machine — the user re-arranges, exactly as in BambuStudio.

### Failure modes

- Slicer unavailable / machine preset unresolvable → save fails with a 409 and a clear message
  (no corruption, source file untouched).
- Process preset unresolvable → machine retarget still applied (the project is still openable/printable
  on the new machine); the process keeps the source preset.

## Where machine profiles come from

The resolver reads the BambuStudio system presets bundled in the **slicer image**:

- `apps/slicer/docker/slicer-targets.mjs` pins the BambuStudio AppImage version(s) (`version` +
  `downloadUrl` per target).
- At image build, `install-slicer-targets.mjs` downloads each AppImage and runs
  `generate-bambustudio-full-profiles.mjs`, which flattens BambuStudio's bundled presets into
  `machine_full/`, `process_full/`, `filament_full/` JSON under each target's `profileDir`. The
  flattener merges **both** the `inherits` chain **and** each preset's `include` templates — the
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
3. **Regenerate the slicer profiles** — in dev, re-bootstrap the in-workspace slicer (delete
   `~/.printstream-slicer` and `npm run dev`, or re-run the generator per the slicer development notes);
   for staging/live, republish the ghcr image via the public repo's CI. This regenerates
   `machine_full/` from the new AppImage, so new machines and new machine fields appear automatically.
4. **Verify the retarget** (below) for at least one single-extruder→multi-extruder switch.

### What is and isn't resilient to BambuStudio changes

- **Resilient (no maintenance):** the machine field-set overwrite is **profile-driven** — it copies
  whatever keys the resolved profile contains, so new/renamed machine settings are carried over with
  no code change.
- **Coupled to BambuStudio (maintenance + verification):** the dependent-map derivation in
  `machine-retarget.ts` (`repairEstimateModeProjectSettings` and its helpers — extruder variants,
  `filament_nozzle_map`, nozzle-volume indices, AMS counts). If BambuStudio changes how multi-extruder
  topology or nozzle-volume types are encoded, this derivation must be updated. The verification below
  is the safety net — it fails loudly (bad slice) when the derivation drifts.

## Verifying after a change

Against a source-built slicer (devcontainer):

1. Retarget a single-extruder project to a multi-extruder machine (e.g. an A1 mini project → H2D) via
   the editor's "switch printer + Save", or by calling `retargetSavedProjectMachine` directly.
2. Confirm the saved 3MF **opens** in the editor (the model renders — i.e. it is a project, not sliced
   output) and that its `project_settings.config` has the target's `printer_model`,
   `printer_settings_id`, **and `print_settings_id`** (process carried over).
3. Confirm it **slices**: run a normal slice of the retargeted project and check for a non-zero, valid
   `.gcode.3mf` (no `filament … not compatible with printer`, no exit 251/segfault).

`data/verify-slice-fix.mjs` (dev, gitignored) does this end-to-end against the sidecar.

Cover at least: A1 mini / A1 (single extruder) and H2D / H2D Pro (dual extruder); a same-family
control (e.g. P1S → X1C) should also slice. Unit coverage for the pure rewrite lives in
`packages/shared/src/machine-retarget.test.ts`.
