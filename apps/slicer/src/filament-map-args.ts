/**
 * Builds the `--filament-map` CLI argument that carries a dual-nozzle MANUAL filament->extruder
 * assignment to BambuStudio.
 *
 * WHY THIS EXISTS. `BambuStudio.cpp` takes `filament_map` from its command-line config
 * (`m_extra_config`); with no flag it falls back to `PartPlate::get_real_filament_maps`, which
 * returns the plate's own map or, failing that, the built-in default `ConfigOptionInts{1}` — a
 * ONE-entry vector. The manual-mode printability check then does an unchecked
 * `filament_maps[plate_filaments[i] - 1]` (BambuStudio.cpp ~6822), so if that fallback lands on
 * the default, every filament past the first reads out of bounds and the slice aborts with a
 * garbage extruder id:
 *
 *   plate 1 : filament Sup.PLA can not be printed on extruder 21840, under manual mode for
 *   multi extruder printer  /  run found error, return -68, exit...
 *
 * Verified against BambuStudio 2.7.1.62 on the issue #63 repro: it fails with the plate/project
 * maps alone, slices with `--filament-map 1,2`, and fails again with `--filament-map "1;2"` (the
 * semicolon is not a separator, so the option parses to a one-entry vector and reproduces the
 * identical garbage id). The separator is therefore a COMMA, and the array must carry one entry
 * per filament — a short array is an out-of-bounds read, not a defaulted one.
 *
 * WHAT IS NOT ESTABLISHED: why that project's plate map failed to reach the engine when other
 * projects' did. Real artifacts sliced without this flag show the engine assigning nozzles
 * correctly (`Best_Shot_Golf__ABS__-_Plate_5.gcode.3mf`, 3 filaments, engine `group_id 0,1,1`
 * matching intent), so the fallback is not universally empty. The flag removes the dependency on
 * that path entirely rather than relying on it — which is the point, given the failure mode is a
 * silent out-of-bounds read.
 *
 * The 3MF writes in `output-metadata.ts` stay: they set the mode the CLI reads and keep the saved
 * artifact's metadata matching the gcode.
 */

/** 1-based slicer extruder per filament, as produced by `buildManualNozzleAssignment`. */
export function buildFilamentMapArgs(filamentMap: readonly string[] | null): string[] {
  if (!filamentMap || filamentMap.length === 0) return []
  return ['--filament-map', filamentMap.join(',')]
}
