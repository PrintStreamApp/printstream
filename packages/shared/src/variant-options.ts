/**
 * Which settings BambuStudio stores PER EXTRUDER VARIANT: the authority for every array width in a
 * project config.
 *
 * OWNS the variant-width rule for BOTH domains. A project's arrays are not one uniform shape: a key
 * in {@link FILAMENT_OPTIONS_WITH_VARIANT} carries one value per (slot x variant) and every other
 * filament key one per slot; the process side splits the same way on
 * {@link PRINT_OPTIONS_WITH_VARIANT}. On a dual-nozzle H2D project with 3 materials that is 6
 * entries versus 3, both correct, for different keys.
 *
 * WHY A TABLE AND NOT ARITHMETIC: width is a property of the OPTION, fixed by BambuStudio's config
 * definition (`filament_options_with_variant` / `print_options_with_variant` in
 * `src/libslic3r/PrintConfig.cpp`). Code here used to infer it instead, dividing an array's length
 * by the slot count, or matching a length against the variant column count, and then apply that one
 * number to every key in the catalog. Both directions are wrong: it widens a per-slot key, and it
 * silently skips a variant key whose length does not fit the guess.
 *
 * That is not cosmetic. `parseProjectFilaments` sizes the material list from the LONGEST filament
 * array, so writing `filament_density` at variant width made a 3-material project reopen showing 6,
 * and BambuStudio, unable to bind either the printer or the filaments from the malformed config,
 * fabricated a `(<project>.3mf)` preset for each. Reproduced end to end on a real project.
 *
 * VERIFIED against a BambuStudio-written file: all 40 filament keys it carried matched this rule
 * exactly, with zero mismatches.
 *
 * Ported verbatim, so keep it that way, this is a mirror of vendor data, not a judgement call.
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

/** BambuStudio's `print_options_with_variant`: the process-side twin. */
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
 * file that dropped the column): the safe floor, because writing a key NARROWER than BambuStudio
 * expects is recoverable while writing it WIDER corrupts the slot count.
 *
 * ONLY VALID WHEN THE LAYOUT IS UNIFORM. Blocks are not always equal width, TPU claims every
 * printer variant while other materials share the standard ones, so prefer
 * {@link filamentVariantRowsPerSlot}, which reads the real per-slot layout and degrades to this
 * division only when the project does not record one.
 */
export function filamentVariantsPerSlot(record: Record<string, unknown>, slotCount: number): number {
  if (slotCount <= 0) return 1
  const declared = record.filament_extruder_variant
  if (!Array.isArray(declared) || declared.length === 0) return 1
  const variants = Math.floor(declared.length / slotCount)
  return variants >= 1 ? variants : 1
}

/**
 * How many variant rows the project declares in total, i.e. the length a variant-scoped filament
 * key must have. Zero when the project declares no variant layout at all (single-variant machine,
 * or a file that dropped the column), where a variant key is simply one value per slot.
 *
 * This is the right authority for JUDGING a width, and it needs no per-slot split: however the rows
 * are distributed, a variant-scoped array carries one value per row. Only WRITING one needs the
 * split ({@link filamentVariantRowsPerSlot}).
 */
export function filamentVariantRowCount(record: Record<string, unknown>): number {
  const declared = record.filament_extruder_variant
  return Array.isArray(declared) ? declared.length : 0
}

/**
 * The number of variant rows EACH filament slot owns, in slot order, for WRITING a variant-scoped
 * array, where the per-slot split matters. Judging a length does not need it
 * ({@link filamentVariantRowCount}).
 *
 * The layout is not uniform, and dividing pretends it is. `buildFilamentVariantRows` gives a TPU
 * slot every printer variant while non-TPU slots share the standard ones, so PLA + TPU on an H2D is
 * 2 + 3 = 5 rows across 2 slots. Applying `floor(5 / 2) = 2` to both slots truncated the TPU slot's
 * last column away and left the array one short of the layout the project declares.
 *
 * `filament_self_index` is the authority: it names the owning slot (1-based) for every row, which is
 * exactly this information, and `buildFilamentVariantRows` emits the two together for that reason.
 *
 * NULL means the split is unknowable: rows that do not divide evenly, with no usable index to say
 * how they are shared. Callers must then leave variant-scoped keys ALONE: an undersized
 * `slots x variants` array is what makes BambuStudio read out of bounds and die mid-slice, and
 * inventing the division is the guess `repairs/index.ts` forbids.
 */
export function filamentVariantRowsPerSlot(record: Record<string, unknown>, slotCount: number): number[] | null {
  if (slotCount <= 0) return null
  const rowCount = filamentVariantRowCount(record)
  // No variant layout declared: a variant-scoped key is simply one value per slot.
  if (rowCount === 0) return Array.from({ length: slotCount }, () => 1)

  const selfIndex = record.filament_self_index
  if (Array.isArray(selfIndex) && selfIndex.length === rowCount) {
    const perSlot = Array.from({ length: slotCount }, () => 0)
    let readable = true
    for (const entry of selfIndex) {
      const slot = Number.parseInt(String(entry), 10)
      // An index naming no slot we have leaves the layout only partly decoded.
      if (!Number.isInteger(slot) || slot < 1 || slot > slotCount) { readable = false; break }
      perSlot[slot - 1]! += 1
    }
    // Every slot must own at least one row for the result to be usable positionally.
    if (readable && perSlot.every((rows) => rows >= 1)) return perSlot
  }
  // Nothing readable to go on: only an evenly divisible layout can be assumed. Anything else is
  // unknowable, and a caller must leave those keys alone rather than invent a split.
  return rowCount % slotCount === 0 ? Array.from({ length: slotCount }, () => rowCount / slotCount) : null
}

/** Columns a filament key occupies per slot in a project with this many variants. */
export function filamentKeyWidth(key: string, variantsPerSlot: number): number {
  return isFilamentVariantOption(key) ? variantsPerSlot : 1
}
