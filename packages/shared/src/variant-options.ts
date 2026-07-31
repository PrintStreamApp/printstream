/**
 * Which settings BambuStudio stores PER EXTRUDER VARIANT — the authority for every array width in a
 * project config.
 *
 * OWNS the variant-width rule for BOTH domains. A project's arrays are not one uniform shape: a key
 * in {@link FILAMENT_OPTIONS_WITH_VARIANT} carries one value per (slot x variant) and every other
 * filament key one per slot; the process side splits the same way on
 * {@link PRINT_OPTIONS_WITH_VARIANT}. On a dual-nozzle H2D project with 3 materials that is 6
 * entries versus 3 — both correct, for different keys.
 *
 * WHY A TABLE AND NOT ARITHMETIC: width is a property of the OPTION, fixed by BambuStudio's config
 * definition (`filament_options_with_variant` / `print_options_with_variant` in
 * `src/libslic3r/PrintConfig.cpp`). Code here used to infer it instead — dividing an array's length
 * by the slot count, or matching a length against the variant column count — and then apply that one
 * number to every key in the catalog. Both directions are wrong: it widens a per-slot key, and it
 * silently skips a variant key whose length does not fit the guess.
 *
 * That is not cosmetic. `parseProjectFilaments` sizes the material list from the LONGEST filament
 * array, so writing `filament_density` at variant width made a 3-material project reopen showing 6,
 * and BambuStudio — unable to bind either the printer or the filaments from the malformed config —
 * fabricated a `(<project>.3mf)` preset for each. Reproduced end to end on a real project.
 *
 * VERIFIED against a BambuStudio-written file: all 40 filament keys it carried matched this rule
 * exactly, with zero mismatches.
 *
 * Ported verbatim, so keep it that way — this is a mirror of vendor data, not a judgement call.
 * Re-extract both lists when vendoring a newer BambuStudio rather than editing entries by hand.
 */

/** BambuStudio's `filament_options_with_variant`. */
export const FILAMENT_OPTIONS_WITH_VARIANT: ReadonlySet<string> = new Set([
  'filament_flow_ratio',
  'filament_max_volumetric_speed',
  'filament_ramming_volumetric_speed',
  'filament_pre_cooling_temperature',
  'filament_ramming_travel_time',
  'filament_ramming_volumetric_speed_nc',
  'filament_pre_cooling_temperature_nc',
  'filament_ramming_travel_time_nc',
  'filament_extruder_id',
  'filament_extruder_variant',
  'filament_retraction_length',
  'filament_retract_length_nc',
  'filament_z_hop',
  'filament_z_hop_types',
  'filament_retract_restart_extra',
  'filament_retraction_speed',
  'filament_deretraction_speed',
  'filament_retraction_minimum_travel',
  'filament_retract_when_changing_layer',
  'filament_wipe',
  'filament_wipe_distance',
  'filament_retract_before_wipe',
  'filament_long_retractions_when_cut',
  'filament_retraction_distances_when_cut',
  'long_retractions_when_ec',
  'retraction_distances_when_ec',
  'nozzle_temperature_initial_layer',
  'nozzle_temperature',
  'filament_flush_volumetric_speed',
  'filament_flush_temp',
  'filament_flush_temp_fast',
  'filament_enable_overhang_speed',
  'filament_bridge_speed',
  'filament_overhang_1_4_speed',
  'filament_overhang_2_4_speed',
  'filament_overhang_3_4_speed',
  'filament_overhang_4_4_speed',
  'filament_overhang_totally_speed',
  'override_process_overhang_speed',
  'volumetric_speed_coefficients',
  'filament_adaptive_volumetric_speed',
  'filament_preheat_temperature_delta',
  'filament_cooling_before_tower',
  'slow_down_min_speed'
])

/** BambuStudio's `print_options_with_variant` — the process-side twin. */
export const PRINT_OPTIONS_WITH_VARIANT: ReadonlySet<string> = new Set([
  'initial_layer_speed',
  'initial_layer_infill_speed',
  'outer_wall_speed',
  'inner_wall_speed',
  'small_perimeter_speed',
  'small_perimeter_threshold',
  'sparse_infill_speed',
  'internal_solid_infill_speed',
  'vertical_shell_speed',
  'top_surface_speed',
  'enable_overhang_speed',
  'overhang_1_4_speed',
  'overhang_2_4_speed',
  'overhang_3_4_speed',
  'overhang_4_4_speed',
  'overhang_totally_speed',
  'enable_height_slowdown',
  'slowdown_start_height',
  'slowdown_start_speed',
  'slowdown_start_acc',
  'slowdown_end_height',
  'slowdown_end_speed',
  'slowdown_end_acc',
  'bridge_speed',
  'gap_infill_speed',
  'support_speed',
  'support_interface_speed',
  'travel_speed',
  'travel_speed_z',
  'default_acceleration',
  'travel_acceleration',
  'travel_short_distance_acceleration',
  'initial_layer_travel_acceleration',
  'initial_layer_acceleration',
  'outer_wall_acceleration',
  'inner_wall_acceleration',
  'sparse_infill_acceleration',
  'top_surface_acceleration',
  'print_extruder_id',
  'print_extruder_variant',
  'top_solid_infill_flow_ratio'
])

/** Whether a FILAMENT setting is stored one value per extruder variant. */
export function isFilamentVariantOption(key: string): boolean {
  return FILAMENT_OPTIONS_WITH_VARIANT.has(key)
}

/** Whether a PROCESS setting is stored one value per extruder variant. */
export function isPrintVariantOption(key: string): boolean {
  return PRINT_OPTIONS_WITH_VARIANT.has(key)
}

/**
 * How many extruder variants the project declares, per filament slot.
 *
 * Read from `filament_extruder_variant`, which is itself variant-scoped: its length is
 * `slots x variants`. Returns 1 when the project does not declare it (single-variant machine, or a
 * file that dropped the column) — the safe floor, because writing a key NARROWER than BambuStudio
 * expects is recoverable while writing it WIDER corrupts the slot count.
 */
export function filamentVariantsPerSlot(record: Record<string, unknown>, slotCount: number): number {
  if (slotCount <= 0) return 1
  const declared = record.filament_extruder_variant
  if (!Array.isArray(declared) || declared.length === 0) return 1
  const variants = Math.floor(declared.length / slotCount)
  return variants >= 1 ? variants : 1
}

/** Columns a filament key occupies per slot in a project with this many variants. */
export function filamentKeyWidth(key: string, variantsPerSlot: number): number {
  return isFilamentVariantOption(key) ? variantsPerSlot : 1
}
