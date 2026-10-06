/**
 * Filament-list and nozzle authoring for the shared 3MF bake.
 * Keeps material identity, per-slot process arrays, physics, mixed definitions,
 * and dual-nozzle assignments together so a save cannot remap only half of them.
 */
import { FILAMENT_SETTING_KEYS } from '../filament-settings.js'
import { FILAMENT_INDEX_PROCESS_KEYS, type ProcessConfig } from '../process-settings.js'
import { rebindProjectFilamentPhysics } from '../filament-rebind.js'
import { isFilamentVariantOption } from '../variant-options.js'
import { inspectProjectFilamentPhysics } from '../repairs/filament-physics.js'
import { applyFilamentPresetBindings } from '../filament-preset-binding.js'
import { restoreFilamentPhysics } from '../repairs/restore-filament-physics.js'
import { resizeParallelPresetRecord } from '../three-mf-project-config.js'
import { remapMixedFilamentComponentIds, serializeMixedFilamentGradientCurve } from '../mixed-filament.js'
import { rebuildFilamentSelfIndex, repairFilamentSelfIndex } from '../filament-variant-index.js'
import type { SceneEditFilament } from '../slicing.js'
import { normalizeColor, sliceExtruderForNozzleId, stringArray } from './index-parser.js'
import { filamentSlotIdRemap, isIdentityFilamentSlotRemap } from './filament-slot-remap.js'

/** Normalize a colour to BambuStudio's `#RRGGBB` form, never returning empty. */
function filamentColourOut(value: string): string {
  return normalizeColor(value) ?? (value.trim().startsWith('#') ? value.trim() : `#${value.trim()}`)
}

/**
 * Per-filament arrays that carry IDENTITY / STRUCTURE (a user choice or the key that drives
 * slice-time re-resolution), not material physics. On a material change these are kept (remapped
 * from the source slot) while every other filament-indexed array is dropped: see
 * {@link applyFilamentList}. `filament_settings_id` must stay: it names the new preset the slicer
 * re-derives physics from; `filament_nozzle_map` is a project-level assignment no filament preset
 * would restore.
 */
const FILAMENT_IDENTITY_KEYS = new Set([
  'filament_colour',
  'filament_type',
  'filament_settings_id',
  'filament_ids',
  'filament_nozzle_map',
  // Says WHAT the material is, not how it prints, so it belongs here rather than with the physics.
  // It is also the only remaining record that a slot is a support material now that `filament_type`
  // stores the RAW type: the engine derives the `PLA-S` the user sees from this flag plus
  // `filament_type` (`PrintConfig.cpp:7569-7638`). Dropping it turned a support slot into an
  // ordinary PLA in the saved file, where the old derived spelling had at least still said so.
  'filament_is_support',
  // Not identity, but it may never be dropped either: `PresetBundle.cpp` reads
  // `config.option<ConfigOptionFloats>("filament_diameter")->values.size()` with NO null check, so
  // an absent key is a null dereference and BambuStudio dies opening the project instead of
  // reporting anything. An absent key and an empty one are not the same thing, and a key the engine
  // assumes into existence is not optional.
  'filament_diameter'
])

/**
 * Machine-domain arrays that live in `project_settings.config` but are indexed by EXTRUDER (or
 * are machine-level lists), NOT by filament. {@link applyFilamentList} identifies filament-indexed
 * arrays by length, and on a dual-nozzle machine with exactly two filaments every one of these
 * length-2 arrays is indistinguishable from a filament array by length alone: the remap would
 * corrupt them on an add/remove and the material-change drop DELETED them (a real save on an H2D
 * stripped `nozzle_diameter`/`physical_extruder_map`/`extruder_type`/`extruder_variant_list`,
 * leaving a project the slicer's machine-switch guard rejects as missing its dual-nozzle
 * topology). These keys must never be remapped or dropped by the filament rewrite.
 *
 * Sourced from BambuStudio's own preset-domain split (vendored source,
 * `libslic3r/Preset.cpp` `s_Preset_printer_options` + `s_Preset_machine_limits_options`, and
 * `PrintConfig.cpp` `init_extruder_option_keys`) plus the runtime-derived machine maps observed
 * in real projects (`extruder_nozzle_stats`, `extruder_ams_count`, `start_end_points`) and the
 * project-level printer-compatibility declarations. The bare extruder-indexed names are listed;
 * their per-filament override twins use `filament_*` prefixes and stay strippable. An unknown NEW
 * machine key from a future BambuStudio would still be misclassified: the slicer-side same-model
 * topology heal (machine-switch-guard) backstops that by re-authoring the machine block.
 */
const MACHINE_DOMAIN_ARRAY_KEYS = new Set([
  // Preset.cpp s_Preset_printer_options (Bambu-relevant subset; scalars included harmlessly).
  'printable_area', 'extruder_printable_area', 'bed_exclude_area', 'gcode_flavor',
  'machine_start_gcode', 'machine_end_gcode', 'printing_by_object_gcode', 'before_layer_change_gcode',
  'layer_change_gcode', 'time_lapse_gcode', 'wrapping_detection_gcode', 'change_filament_gcode',
  'printer_model', 'printer_variant', 'printer_extruder_id', 'printer_extruder_variant',
  'extruder_variant_list', 'default_nozzle_volume_type', 'printable_height', 'extruder_printable_height',
  'extruder_clearance_dist_to_rod', 'extruder_clearance_max_radius', 'extruder_clearance_height_to_lid',
  'extruder_clearance_height_to_rod', 'nozzle_height', 'master_extruder_id', 'default_print_profile',
  'silent_mode', 'scan_first_layer', 'wrapping_detection_layers', 'wrapping_exclude_area',
  'machine_load_filament_time', 'machine_unload_filament_time', 'machine_pause_gcode',
  'template_custom_gcode', 'machine_hotend_change_time', 'nozzle_type', 'auxiliary_fan', 'fan_direction',
  'nozzle_volume', 'upward_compatible_machine', 'z_hop_types', 'support_chamber_temp_control',
  'support_air_filtration', 'support_cooling_filter', 'cooling_filter_enabled', 'printer_structure',
  'thumbnail_size', 'best_object_pos', 'head_wrap_detect_zone', 'printer_notes', 'print_in_clockwise',
  'enable_long_retraction_when_cut', 'long_retractions_when_cut', 'retraction_distances_when_cut',
  'use_relative_e_distances', 'extruder_type', 'use_firmware_retraction', 'grab_length',
  'machine_switch_extruder_time', 'hotend_cooling_rate', 'hotend_heating_rate', 'enable_pre_heating',
  'support_object_skip_flush', 'physical_extruder_map', 'bed_temperature_formula',
  'machine_prepare_compensation_time', 'nozzle_flush_dataset', 'group_algo_with_time',
  'extruder_max_nozzle_count', 'support_fast_purge_mode',
  // Preset.cpp s_Preset_machine_limits_options.
  'machine_max_acceleration_extruding', 'machine_max_acceleration_retracting', 'machine_max_acceleration_travel',
  'machine_max_acceleration_x', 'machine_max_acceleration_y', 'machine_max_acceleration_z', 'machine_max_acceleration_e',
  'machine_max_speed_x', 'machine_max_speed_y', 'machine_max_speed_z', 'machine_max_speed_e',
  'machine_min_extruding_rate', 'machine_min_travel_rate',
  'machine_max_jerk_x', 'machine_max_jerk_y', 'machine_max_jerk_z', 'machine_max_jerk_e',
  'machine_max_force_Y', 'machine_bed_mass_Y', 'machine_max_printed_mass',
  // PrintConfig.cpp init_extruder_option_keys: the bare extruder-indexed names as they appear in
  // project_settings (the filament-override twins are `filament_*`-prefixed and stay strippable).
  'nozzle_diameter', 'min_layer_height', 'max_layer_height', 'extruder_offset',
  'retraction_length', 'z_hop', 'retraction_speed', 'retract_lift_above', 'retract_lift_below',
  'deretraction_speed', 'retract_before_wipe', 'retract_restart_extra', 'retraction_minimum_travel',
  'wipe', 'wipe_distance', 'retract_when_changing_layer', 'retract_length_toolchange',
  'retract_restart_extra_toolchange', 'extruder_colour', 'default_filament_profile',
  // Runtime-derived machine maps + project-level printer compatibility (not in the BBS preset
  // lists, but extruder-indexed / machine-identity in real project files).
  'extruder_nozzle_stats', 'extruder_ams_count', 'start_end_points', 'print_compatible_printers',
  // Per-EXTRUDER flush sizing + nozzle volume types (project keys, not preset keys: see
  // flush-volumes-matrix.ts). On a dual-nozzle machine with two filaments these length-2 arrays
  // are indistinguishable from filament arrays by length, and remapping them swaps or resizes the
  // per-extruder entries: a filament add stretched `flush_multiplier` past the extruder count,
  // which is the exact shape BambuStudio's g-code-time size check rejects (exit 156).
  'flush_multiplier', 'flush_multiplier_fast', 'nozzle_volume_type'
])

/**
 * Replace `project_settings.config`'s filament set with the desired ordered list
 * (Bambu-style add/remove of materials). Position `i` becomes filament `i + 1`.
 *
 * To stay resilient to BambuStudio version differences (project_settings carries many
 * parallel filament-indexed arrays we don't enumerate), EVERY top-level array whose
 * length equals the current filament count: except the machine/extruder-domain keys in
 * {@link MACHINE_DOMAIN_ARRAY_KEYS}, which are extruder-indexed and merely length-collide
 * with the filament count on dual-nozzle machines: is remapped by an index map: a desired slot
 * copies its `sourceIndex` (an existing filament's settings) so new/cloned slots inherit
 * a valid profile, then `filament_colour`/`filament_type` are set from the desired list.
 * The square `flush_volumes_matrix` (count x count) is rebuilt row/column-wise. When the
 * source has no filament arrays (a from-scratch project) only colour/type are written and
 * the slicer fills the rest from the filament profiles supplied at slice time.
 *
 * VARIANT EXPANSION (BambuStudio 2.x). On machines with extruder variants (H2D, and X1C's
 * standard/high-flow pair) the numeric filament settings are `filaments x variants` long:
 * slot i owns the V-wide block at i*V, V read from `filament_extruder_variant`'s length.
 * Those arrays get the same treatment block-wise (remap on reorder, drop on material change),
 * but ONLY for keys positively classified as filament-domain (the filament catalog +
 * `filament_extruder_variant` itself, which always survives by remap, it is the layout's
 * identity column): an N*V length alone would convict per-plate arrays. A filament-catalog
 * array whose length matches NEITHER width is provably stale (a pre-variant-aware save left
 * it behind) and is dropped so the slicer re-derives it, one re-save heals a diseased file.
 *
 * MATERIAL CHANGE (e.g. ABS -> PETG). Cloning `sourceIndex`'s arrays copies the OLD material's
 * per-filament physics (chamber/plate/nozzle temps, flow, cooling, retraction, ...), so a naive
 * remap leaves the project "PETG by name, ABS by temperature". When any slot's material identity
 * (type or `settingsId`) differs from its source slot, we therefore DROP every non-identity
 * filament array, which also removes the `nozzle_temperature` completeness sentinel. The slicer's
 * {@link ensureEmbeddedProjectSettings} / `ensureFilamentCoverage` (apps/slicer) then re-derives
 * the physics from the kept `filament_settings_id` preset names at slice time, so the new material
 * slices with its own temperatures. This heals only NEW saves (the embedded config the slicer
 * reads); already-saved projects keep their stale physics until re-saved. Identity/structure keys
 * ({@link FILAMENT_IDENTITY_KEYS}) are still remapped so the user's colours and nozzle assignment
 * survive; imported projects with no material change are left byte-for-byte (full clone, no drop),
 * preserving any in-desktop-BambuStudio filament tweaks.
 */
export function applyFilamentList(projectSettingsJson: string, filaments: SceneEditFilament[]): string {
  if (filaments.length === 0) return projectSettingsJson
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return projectSettingsJson
  }
  if (!parsed || typeof parsed !== 'object') return projectSettingsJson
  const record = parsed as Record<string, unknown>

  const oldCount = Math.max(
    Array.isArray(record.filament_colour) ? record.filament_colour.length : 0,
    Array.isArray(record.filament_type) ? record.filament_type.length : 0,
    Array.isArray(record.filament_settings_id) ? record.filament_settings_id.length : 0
  )
  const newCount = filaments.length
  /**
   * Whether slot `i` switched material, published out of the remap block below so the
   * `filament_ids` authoring at the end can tell "kept its material" (keep the id) from "changed
   * material with no resolvable id" (report unknown). Null when there was no base list to compare
   * against, in which case nothing was carried over and no slot counts as changed.
   */
  let materialChangedBySlot: ((index: number) => boolean) | null = null

  if (oldCount > 0) {
    // Desired slot i is seeded from this old index (clamped into range).
    const sourceFor = (i: number): number => {
      const requested = filaments[i]?.sourceIndex
      const idx = requested == null ? i : requested
      return idx >= 0 && idx < oldCount ? idx : 0
    }
    // A slot changed material iff its desired type/settingsId differs from the slot it clones from.
    const sourceTypes = Array.isArray(record.filament_type) ? record.filament_type : []
    const sourceSettingsIds = Array.isArray(record.filament_settings_id) ? record.filament_settings_id : []
    const slotMaterialChanged = (i: number): boolean => {
      const src = sourceFor(i)
      const filament = filaments[i]
      return (filament?.settingsId != null && filament.settingsId !== sourceSettingsIds[src])
        || (filament?.type != null && filament.type !== sourceTypes[src])
    }
    const materialChanged = filaments.some((_filament, i) => slotMaterialChanged(i))
    materialChangedBySlot = slotMaterialChanged
    // When the caller resolved the new presets, the old material's physics is REPLACED rather than
    // dropped: see `authorFilamentPhysics` below. The drop stays for a caller that could not
    // resolve them, so nothing regresses.
    const authoringPhysics = materialChanged && filaments.some((filament) => filament.config != null)
    // BambuStudio 2.x VARIANT EXPANSION: on machines with extruder variants (H2D dual-nozzle, and
    // even X1C's standard/high-flow pair) the numeric per-filament settings carry one value per
    // (filament x variant): `filament_extruder_variant` is that same layout's identity column, so
    // its length over the filament count gives the block width. A remap/drop that only recognizes
    // `length === oldCount` silently skips every such array, which is how a material switch kept
    // the OLD material's physics: identity keys (N-long) renamed the filament to PETG while the
    // N*V-long temperature arrays still said ABS (seen in production as phantom "changed" badges;
    // slices stayed correct only because slice-prep re-derives mapped columns independently).
    const variantColumns = Array.isArray(record.filament_extruder_variant) ? record.filament_extruder_variant.length : 0
    const variantCount = variantColumns > oldCount && variantColumns % oldCount === 0 ? variantColumns / oldCount : 1
    for (const [key, value] of Object.entries(record)) {
      if (!Array.isArray(value)) continue
      // Machine/extruder-domain arrays are indexed by extruder, not filament, on a machine
      // whose extruder count happens to equal the filament count (2 and 2 on a dual-nozzle
      // H2D) the length test below cannot tell them apart, and remapping or dropping them
      // destroys the project's machine topology. Never touch them here.
      if (MACHINE_DOMAIN_ARRAY_KEYS.has(key)) continue
      // The custom layer print sequences hold filament ids as VALUES (an ordered "print these
      // slots in this order" list, plus layer-range bounds), not one entry per slot: when a
      // sequence's length happens to equal the filament count, the positional remap below would
      // scramble it. They are re-keyed value-wise at the end of this function instead.
      if (key === 'first_layer_print_sequence' || key === 'other_layers_print_sequence') continue
      if (key === 'flush_volumes_matrix') {
        // One `filaments x filaments` block PER EXTRUDER, not a single square: see
        // `expectedFlushVolumesMatrixLength`. Remapping only the first block (which is all a
        // square rebuild produces) leaves a dual-nozzle project a block short, and BambuStudio
        // reads the missing block out of bounds and segfaults mid-slice.
        const extruderCount = Math.max(stringArray(record.nozzle_diameter).length, 1)
        const sourceBlocks = value.length > 0 && value.length % (oldCount * oldCount) === 0
          ? value.length / (oldCount * oldCount)
          : 0
        if (sourceBlocks > 0) {
          // A pair involving a filament the project did not have is SEEDED, never cloned from the
          // slot the new one was added beside. BambuStudio seeds it from `flush_volumes_vector`
          // (`update_multi_material_filament_presets`: `i == j ? 0 : filaments[2i] + filaments[2j+1]`,
          // 140 + 140 = 280 by default) and writes 0 only on the diagonal.
          //
          // Cloning read the SOURCE slot's own diagonal for the new pair, which is hard zero, so
          // adding a material left the print purging NOTHING between it and the slot it was added
          // beside: the new colour prints contaminated until it clears itself. Worst on a
          // single-filament project, whose stored matrix is just `["0"]` and whose every cloned
          // cell was therefore zero. Nothing detected any of it, because the guard here is a length
          // test and the matrix came out the right length.
          const flushVector = stringArray(record.flush_volumes_vector)
          // ALWAYS strings, never the source's cell type. `parse_str_arr` accepts only array and
          // string elements and returns false on anything else (`Config.cpp:836-860`), so a JSON
          // NUMBER is fatal whether or not the array is mixed: the loader logs, `break`s out of the
          // key loop (`:996-1000`) and then returns success (`:1123`), silently dropping every key
          // ordered after this one. This used to match the source's type, which preserved a numeric
          // matrix faithfully into a file the engine cannot read. Strings are also what BambuStudio
          // itself emits for every vector option (`Config.cpp:1512-1523` serialises through a
          // `vector<string>`), so this is matching the engine rather than choosing a format.
          const cell = (amount: number): string => String(amount)
          const seedFor = (row: number, col: number): string => {
            if (row === col) return cell(0)
            const unload = Number.parseFloat(flushVector[row * 2] ?? '')
            const load = Number.parseFloat(flushVector[col * 2 + 1] ?? '')
            // No usable vector: keep BambuStudio's own default pair rather than invent a number.
            if (!Number.isFinite(unload) || !Number.isFinite(load)) return cell(280)
            return cell(unload + load)
          }
          // Carried cells are normalised too: a source that arrived numeric must not survive as
          // numeric just because its value was reachable.
          const carryCell = (raw: unknown): string | undefined =>
            raw == null ? undefined : typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : undefined
          const next: unknown[] = []
          for (let extruder = 0; extruder < extruderCount; extruder++) {
            // A retarget that ADDED an extruder has no block for it yet; seed it from the last
            // one the project actually has rather than zero-filling a usable matrix away.
            const base = Math.min(extruder, sourceBlocks - 1) * oldCount * oldCount
            for (let row = 0; row < newCount; row++) {
              for (let col = 0; col < newCount; col++) {
                const carried = row < oldCount && col < oldCount
                next.push(carried
                  ? carryCell(value[base + sourceFor(row) * oldCount + sourceFor(col)]) ?? seedFor(row, col)
                  : seedFor(row, col))
              }
            }
          }
          record[key] = next
        }
        continue
      }
      if (key === 'flush_volumes_vector') {
        // `[unload_i, load_i]` PAIRS, one per filament slot: BambuStudio seeds new matrix cells
        // from `filaments[2*i] + filaments[2*j+1]` (PresetBundle::update_multi_material_filament_
        // presets). Its 2N length hides it from the generic remap below, and BambuStudio itself
        // only ever resizes it at the TAIL, so a mid-list remove or reorder must move the pairs
        // with their slots here or the per-material purge volumes describe the wrong filaments.
        // 140 is BambuStudio's default entry, used when the source pair is absent or short.
        record[key] = Array.from({ length: newCount * 2 }, (_unused, index) => {
          const source = sourceFor(Math.floor(index / 2)) * 2 + (index % 2)
          return value[source] ?? '140'
        })
        continue
      }
      // Variant-expanded arrays are handled ONLY for keys we can positively classify as
      // filament-domain (the filament catalog, plus the layout's own identity column): unlike the
      // N-long path below, an N*V length is too weak a signal on its own (a 4-plate project with
      // 2 filaments x 2 variants would convict per-plate arrays like `wipe_tower_x`).
      // Classified by BambuStudio's OPTION rule, not by length. A length test both convicts and
      // acquits wrongly: an ordinary per-slot array whose count happens to equal `slots x variants`
      // gets re-blocked, while a genuine variant key stored at another width is skipped. The layout's
      // own identity column is variant-scoped by definition. See `variant-options.ts`.
      const isVariantExpanded = variantCount > 1 && value.length === oldCount * variantCount
        && (key === 'filament_extruder_variant' || isFilamentVariantOption(key))
      if (isVariantExpanded) {
        // Slot i owns the V-wide block starting at i*V. The layout's identity column
        // (`filament_extruder_variant`) must ALWAYS survive by block-remap: losing it breaks the
        // variant topology every other N*V-long key is decoded against.
        if (key !== 'filament_extruder_variant' && materialChanged && !authoringPhysics) {
          // Same rule, and the same GATE, as the N-long arrays below: drop the OLD material's
          // physics only when the caller could not resolve the new presets, and let the slicer
          // re-derive every column from the kept `filament_settings_id` at slice time.
          //
          // The gate used to be missing here, which is not a smaller version of the same bug: a
          // dropped key is unrecoverable within the save, because `rebindProjectFilamentPhysics`
          // below only rewrites keys still PRESENT. So an editor save that HAD resolved the presets
          // still lost every `filament_options_with_variant` key, three of the five completeness
          // sentinels among them, and wrote a project BambuStudio opens as unnamed default presets.
          // The N-long keys beside them were re-authored correctly, which is what made the damage
          // look partial and material-specific rather than variant-specific.
          delete record[key]
          continue
        }
        const next: unknown[] = []
        for (let i = 0; i < newCount; i++) {
          const base = sourceFor(i) * variantCount
          for (let variant = 0; variant < variantCount; variant++) next.push(value[base + variant])
        }
        record[key] = next
        continue
      }
      if (value.length !== oldCount) {
        // A filament-catalog array whose length matches NEITHER the filament count NOR its
        // variant-expanded width is provably stale: leftovers from an earlier filament set that a
        // pre-variant-aware save failed to rewrite (production files carry 10 columns beside a
        // 1-entry filament list). No index mapping can read it correctly, so drop it and let the
        // slicer re-derive from `filament_settings_id`. Keys outside the filament catalog (per-plate
        // arrays like `wipe_tower_x`, unknown domains) are left alone: length alone doesn't
        // convict them.
        //
        // SCOPED TO THE TUNE CATALOGUE ON PURPOSE, and narrower than what detection judges: the
        // inspector reads BambuStudio's full filament option list, so a handful of variant-scoped
        // keys it can flag (`volumetric_speed_coefficients`, `filament_preheat_temperature_delta`)
        // are invisible here. That is not a gap to close by widening this set. Deleting more of a
        // user's document during an ORDINARY save is the behind-the-scenes repair this project
        // deliberately does not do; those keys are rewritten by `restoreFilamentPhysics` when the
        // user asks for a repair, which `settings-repair-roundtrip.test.ts` pins end to end.
        if (FILAMENT_SETTING_KEYS.has(key) && !FILAMENT_IDENTITY_KEYS.has(key)) delete record[key]
        continue
      }
      if (materialChanged && !authoringPhysics && !FILAMENT_IDENTITY_KEYS.has(key)) {
        // No resolved presets to author from, so drop the OLD material's cloned physics and let the
        // slicer re-derive it from the name. Leaves the project incomplete for BambuStudio, which is
        // why a caller that CAN resolve the presets takes the authoring path instead.
        delete record[key]
        continue
      }
      record[key] = Array.from({ length: newCount }, (_unused, i) => value[sourceFor(i)])
    }
    remapMixedFilamentReferences(record, newCount, sourceFor)
    // `different_settings_to_system` and `inherits_group` are PARALLEL PRESET RECORDS,
    // `[process, ...filament slots, machine]` (length oldCount+2), so the generic remap above skips
    // both. `resizeParallelPresetRecord` rebuilds them: each new slot follows its source slot, and a
    // slot whose MATERIAL changed is blanked.
    //
    // Blanking is right for both, for two different reasons. The changed-from-system record is the
    // authoritative "changed within this 3MF" signal the material dialog reads, so a stale entry
    // would flag keys the new material never touched. And a slot that no longer inherits the old
    // material's parent gets the honest empty value, which the CLI reads as "this slot IS a system
    // preset"; the binding pass fills in the real parent when it could resolve one.
    //
    // Leaving `inherits_group` at the OLD width is FATAL, not untidy: the CLI sizes its
    // filament-system-name vector from THIS array (`current_filaments_system_name.resize(size - 2)`)
    // and then indexes `filament_settings_id` with it, unguarded, so an entry left behind by a
    // removed slot makes BambuStudio read past the end of the filament names and SIGSEGV while
    // loading the project, before slicing starts (opaque exit 139). Seen in production: a project
    // taken from 5 filaments to 1 kept 7 entries here and killed every slice of that file.
    // `applyFilamentPresetBindings` also rebuilds it, but only when at least one slot resolved a
    // preset: the SIZE invariant has to hold regardless of whether it did.
    const resizeOptions = {
      oldFilamentCount: oldCount,
      newFilamentCount: newCount,
      sourceSlotFor: (slot: number) => (slotMaterialChanged(slot) ? null : sourceFor(slot))
    }
    for (const key of ['different_settings_to_system', 'inherits_group'] as const) {
      // Only a record already at the expected width is rebuilt: a mis-sized one is a defect the
      // Repair stage owns, and quietly reshaping it during an ordinary save is the behind-the-scenes
      // healing this project deliberately does not do.
      const previous = record[key]
      if (!Array.isArray(previous) || previous.length !== oldCount + 2) continue
      const resized = resizeParallelPresetRecord(previous, resizeOptions)
      if (resized) record[key] = resized
    }
  }

  // Write each changed slot's NEW material physics from its resolved preset, replacing the values
  // cloned from the slot it came from. This is what keeps a saved project self-contained: the file
  // carries the material's own temperatures, flow, cooling and retraction rather than only its name,
  // so BambuStudio can bind the slot to a NAMED preset instead of inventing an unnamed one from bare
  // defaults. Runs INSTEAD of the wholesale drop above, never after it: `rebindProjectFilamentPhysics`
  // only rewrites keys that are still present, so a dropped key would stay dropped. It preserves a
  // slot's genuine in-project overrides by contract (`different_settings_to_system`), which is the
  // behaviour a save wants: the user's own tweaks outlive a material change.
  if (materialChangedBySlot && filaments.some((filament) => filament.config != null)) {
    const rebound = rebindProjectFilamentPhysics(record, filaments.map((filament, i) => ({
      // Only a CHANGED slot is re-authored; an untouched slot keeps what the project already had.
      config: materialChangedBySlot(i) ? (filament.config as ProcessConfig | null) ?? null : null,
      settingsId: null
    })))
    for (const key of Object.keys(record)) if (!(key in rebound)) delete record[key]
    Object.assign(record, rebound)
  }

  // Name each slot's parent preset and declare what it changed. Writing the VALUES above is only
  // half of binding a slot: BambuStudio normalizes a slot against its parent before comparing it to
  // the installed preset, and for a USER preset that step is reached only through `inherits_group`.
  // Without it a slot whose values were byte-identical to a BambuStudio-written file still opened
  // as a `(<project>.3mf)` copy. See `filament-preset-binding.ts`.
  applyFilamentPresetBindings(record, filaments.map((filament) => (
    filament.presetInherits === undefined && filament.presetChangedKeys === undefined
      ? null
      : { inherits: filament.presetInherits ?? null, changedKeys: filament.presetChangedKeys ?? [] }
  )))

  // Authoritative colour/type from the desired list (overrides the cloned values above).
  record.filament_colour = filaments.map((filament) => filamentColourOut(filament.color))
  const previousTypes = Array.isArray(record.filament_type) ? record.filament_type : []
  // Written as `SceneEditFilament.type` gives it, which is the DERIVED display type ("PLA-S").
  //
  // That spelling is wrong for the engine: `get_filament_temp_type` (`Print.cpp:2703-2710`)
  // matches raw type names only, so a support slot falls out of the temperature-compatibility
  // tally and mixing it with a high-temp filament is not reported. Storing the raw type was tried and REVERTED, because
  // `slotMaterialChanged` compares this same `filament.type` against the stored value: making the
  // two different spellings marks every support slot as changed on every save, which drops the
  // material physics and wipes that slot's `inherits_group`. Fixing it means teaching the
  // COMPARISON to derive both sides, not just changing what is written.
  record.filament_type = filaments.map((filament, i) => filament.type ?? (typeof previousTypes[i] === 'string' ? previousTypes[i] : 'PLA'))
  authorMixedFilamentDefinitions(record, filaments)
  // Persist the chosen filament preset name per slot so a material PROFILE change (e.g. PLA -> PETG)
  // survives a save, otherwise `filament_settings_id` keeps the prior preset and the project reopens
  // as the old material (with a name/type mismatch). A slot with no explicit `settingsId` keeps the
  // value carried over from its source slot above.
  // NEVER an empty name. An empty entry resolves to no preset, so BambuStudio mints a
  // project-embedded preset out of its BARE CONFIG DEFAULTS (max volumetric speed 2, flow ratio 1,
  // `compatible_printers` All) and names it `(<project>.3mf)`: the empty name plus its project
  // suffix, with `1(<project>.3mf)` for a second one. It then writes that junk preset into the file
  // as a `Metadata/filament_settings_N.config` sidecar and re-embeds it on EVERY later save (see
  // `PresetCollection::get_project_embedded_presets`), so one bad save follows the project forever
  // and the slot prints with default physics. Reported from a real file: slots reading
  // `1(test.3mf)` / `(test.3mf)`.
  //
  // The remap above only supplies a name when the base HAD a filament list; an editor-born project
  // (`oldCount === 0`) has none, so a slot whose material never resolved to a preset arrived here
  // with nothing. It inherits the name of the slot its physics were cloned from instead, the same
  // `sourceIndex` every other per-filament array is remapped through, so the name and the physics
  // describe one material. The gate below guarantees at least one resolved name exists to fall back
  // to, which is what makes the empty case unreachable rather than merely unlikely.
  if (filaments.some((filament) => filament.settingsId)) {
    const previousSettingsIds = Array.isArray(record.filament_settings_id) ? record.filament_settings_id : []
    const previousNameAt = (index: number): string | null =>
      (typeof previousSettingsIds[index] === 'string' && previousSettingsIds[index] !== ''
        ? previousSettingsIds[index] as string
        : null)
    const clonedFrom = (index: number): number => {
      const requested = filaments[index]?.sourceIndex
      const source = requested == null ? index : requested
      return source >= 0 && source < filaments.length ? source : 0
    }
    const anyResolvedName = filaments.find((filament) => filament.settingsId)?.settingsId as string
    record.filament_settings_id = filaments.map((filament, i) => {
      const source = clonedFrom(i)
      return filament.settingsId
        ?? previousNameAt(i)
        ?? filaments[source]?.settingsId
        ?? previousNameAt(source)
        ?? anyResolvedName
    })
  }

  // `filament_ids` is BambuStudio's BINDING key, and it must describe the same preset as
  // `filament_settings_id` above. BambuStudio guarantees that by construction, both arrays are
  // parallel projections of one selected-preset list (`PresetBundle`: `filament_settings_id` gets
  // `preset.name`, `filament_ids` gets `preset.filament_id`), so they cannot drift. Ours could,
  // because `filament_ids` is an IDENTITY key above and identity keys are cloned from the slot a
  // material came FROM. That is right for a colour or a nozzle pick (user choices worth carrying)
  // and wrong here: the id is derived from the material, so switching a slot's material kept the old
  // material's id under the new name. A real ABS -> PETG project therefore saved as
  // `["GFB00","GFB00","GFS06"]` (ABS, ABS, Support-for-ABS) while naming PETG HF and PLA Basic;
  // BambuStudio could not reconcile the two and fabricated a defaults-only project preset per slot,
  // named `(<project>.3mf)`. Sliced output was unaffected only because slice prep re-derives the
  // filament config from the NAMES.
  //
  // Mirrors BambuStudio for the unknown case too: it emplaces `preset.filament_id`, which is `""`
  // when the preset declares none (after the parent-preset fallback), so an unknown id is an EMPTY
  // entry that keeps the array positional, never a stale value, and never a dropped key.
  {
    const previousIds = Array.isArray(record.filament_ids) ? record.filament_ids : []
    const previousIdAt = (index: number): string | null =>
      (typeof previousIds[index] === 'string' ? previousIds[index] as string : null)
    const changedAt = materialChangedBySlot ?? (() => false)
    if (filaments.some((filament) => filament.filamentId) || previousIds.length > 0) {
      record.filament_ids = filaments.map((filament, i) => (
        // An explicit id always wins; otherwise a slot that kept its material keeps its id, and a
        // slot that CHANGED material without a resolvable id reports unknown rather than lying.
        filament.filamentId ?? (changedAt(i) ? '' : previousIdAt(i) ?? '')
      ))
    }
  }

  // Scalar filament-INDEX process values (`support_filament` and friends) each name a 1-based slot
  // (0 = "Default": the object's own filament), so a save that renumbers slots must move them like
  // the parallel arrays above. A value whose slot was removed, or that dangled beyond the old
  // list, has its key deleted, falling back to the default the way BambuStudio's own delete path
  // and the session-side `remapFilamentIndexOverrides` do.
  const slotIdRemap = filamentSlotIdRemap(filaments)
  for (const key of FILAMENT_INDEX_PROCESS_KEYS) {
    const raw = record[key]
    const value = typeof raw === 'string' || typeof raw === 'number' ? Number.parseInt(String(raw), 10) : Number.NaN
    if (!Number.isInteger(value) || value < 1) continue
    const moved = slotIdRemap.get(value)
    if (moved == null) delete record[key]
    else if (moved !== value) record[key] = String(moved)
  }

  // Custom layer print sequences are ordered lists of 1-based filament ids and must follow the
  // permutation too. `first_layer_print_sequence` is a plain id list (a leading "0" means AUTO and
  // carries no ids); `other_layers_print_sequence` is `other_layers_print_sequence_nums` equal
  // chunks of `[rangeStart, rangeEnd, ...filamentIds]` (BambuStudio's ParameterUtils.cpp). An id
  // whose slot was removed is dropped from every chunk, mirroring BambuStudio's delete handling
  // (`PartPlate::update_first_layer_print_sequence_when_delete_filament`); a file whose chunks
  // would come out unequal, the flat encoding cannot express that, is left untouched instead.
  if (Array.isArray(record.first_layer_print_sequence)
    && record.first_layer_print_sequence.length > 0
    && String(record.first_layer_print_sequence[0]) !== '0') {
    record.first_layer_print_sequence = record.first_layer_print_sequence
      .map((entry) => slotIdRemap.get(Number.parseInt(String(entry), 10)))
      .filter((id): id is number => id != null)
      .map((id) => String(id))
  }
  const otherLayersSequence = record.other_layers_print_sequence
  const sequenceChunks = Number.parseInt(String(record.other_layers_print_sequence_nums ?? ''), 10)
  if (Array.isArray(otherLayersSequence) && Number.isInteger(sequenceChunks) && sequenceChunks > 0
    && otherLayersSequence.length % sequenceChunks === 0) {
    const chunkSize = otherLayersSequence.length / sequenceChunks
    const chunks: string[][] = []
    for (let chunk = 0; chunk < sequenceChunks; chunk += 1) {
      const base = chunk * chunkSize
      const ids = otherLayersSequence.slice(base + 2, base + chunkSize)
        .map((entry) => slotIdRemap.get(Number.parseInt(String(entry), 10)))
        .filter((id): id is number => id != null)
        .map((id) => String(id))
      chunks.push([String(otherLayersSequence[base]), String(otherLayersSequence[base + 1]), ...ids])
    }
    if (chunks.every((chunk) => chunk.length === chunks[0]!.length)) {
      record.other_layers_print_sequence = chunks.flat()
    }
  }

  // `filament_self_index` rows carry the 1-based filament index per variant row. Uniform variant
  // blocks make it order-invariant, but a moved TPU slot changes the block widths and the stored
  // index would misdescribe the layout at its correct length. Rebuild it for the final slot order;
  // null (unreconstructable) leaves the file for the parse-side inspection to flag rather than
  // writing a plausible-looking wrong value.
  if (!isIdentityFilamentSlotRemap(slotIdRemap)) {
    const rebuiltSelfIndex = rebuildFilamentSelfIndex(record)
    if (rebuiltSelfIndex) record.filament_self_index = rebuiltSelfIndex
  }
  // And bring it back to the layout's length whenever THIS save changed the filament count,
  // whatever the remap looked like.
  //
  // Gated on the count, not run unconditionally, because those are different acts. Writing a
  // correctly sized array for a list we just grew or shrank is AUTHORING: we invalidated the old
  // one, so leaving it is writing a defect. Conforming an array on a save that changed nothing
  // would be repairing someone's stored file without being asked, which is the thing
  // `repairs/index.ts` forbids and `machine-retarget-variant-index.test.ts` pins.
  //
  // A remap only describes slots that SURVIVED, so appending a material and removing the last one
  // both look like the identity and skipped the rebuild above, while `filament_extruder_variant`
  // (a variant-scoped key) grew or shrank with the filament list. `filament_self_index` is in
  // neither the filament catalog nor the variant option set, so no other branch of this loop
  // resizes it either: it simply fell through at its old length.
  //
  // BambuStudio REFUSES TO OPEN the result. `load_config_file_config` throws "Invalid configuration
  // file" when `filament_extruder_variant.size() != filament_self_index.size()`, so an ordinary
  // Add-material wrote a project the user could no longer open in Studio. The CLI rebuilds the array
  // itself before slicing, which is exactly why this stayed invisible: the file still sliced here.
  //
  // Same implementation the parse-side inspection and the staged repair use, so a file cannot be
  // authored into a shape one of them would call broken. Null means unreconstructable, which leaves
  // the old value for the inspection to flag rather than writing a plausible wrong one.
  if (oldCount > 0 && newCount !== oldCount) {
    const conformedSelfIndex = repairFilamentSelfIndex(record)
    if (conformedSelfIndex) record.filament_self_index = conformedSelfIndex
  }

  // A project whose physics was DROPPED by an older save has no arrays left for
  // `rebindProjectFilamentPhysics` to rewrite (it only touches keys still present), so the values are
  // written from scratch instead: see `repairs/restore-filament-physics.ts` for why the column width
  // has to come from the preset rather than be guessed. This is what makes SAVING the repair for the
  // `filamentPhysics` defect: reopening an affected project and saving restores its materials.
  //
  // Judged on the RECORD THIS PASS HAS BUILT, and therefore LAST -- after the identity arrays above
  // exist. Two things depend on that placement, and the second is why this sits at the end of the
  // function rather than beside the rebind it complements.
  //
  // It cannot read the INPUT: a physics defect introduced by this same pass could then never be
  // restored by it, and one was (the variant-scoped drop wrote a project missing three of the five
  // completeness sentinels while the input was healthy, so the gate saw nothing to do).
  //
  // And it cannot run before the identity is written: `inspectProjectFilamentPhysics` counts SLOTS,
  // and a from-scratch bake (`applyProjectSettings('{}')`, which is every editor-born project's
  // first save) has none until the arrays below are assigned. Judging the empty record returned
  // null -- "nothing to judge" -- so a new project saved every material's physics into the void
  // however completely the editor had resolved it, and reopened flagged `filamentPhysics` on a file
  // the bake had just been handed the values for. The bake's own output check said so at the time,
  // in a log line nobody was reading: "wrote ... with repairable settings defects: filamentPhysics".
  //
  // Not a widening of what gets repaired. An unchanged pass produces the input, so an already-broken
  // project behaves exactly as before, and the restore still writes nothing without resolved presets
  // to write from, which is what keeps the deliberate no-preset drop above intact.
  if (inspectProjectFilamentPhysics(JSON.stringify(record))?.inconsistent === true) {
    restoreFilamentPhysics(record, filaments.map((filament) => (filament.config as ProcessConfig | null) ?? null))
  }

  return JSON.stringify(record)
}

/**
 * Remap component references after the generic parallel-array move has relocated mixed slots.
 *
 * Component ids are values in the old 1-based filament space. A removed source becomes zero,
 * BambuStudio's visible broken-reference sentinel, instead of silently targeting a different slot.
 */
function remapMixedFilamentReferences(
  record: Record<string, unknown>,
  newCount: number,
  sourceFor: (newIndex: number) => number
): void {
  if (!Array.isArray(record.filament_mixed_components)) {
    return
  }

  const mixedFlags = Array.isArray(record.filament_is_mixed)
    ? record.filament_is_mixed
    : []
  const newSlotForOldSlot = new Map<number, number>()

  for (let newIndex = 0; newIndex < newCount; newIndex++) {
    const oldSlot = sourceFor(newIndex) + 1
    if (!newSlotForOldSlot.has(oldSlot)) {
      newSlotForOldSlot.set(oldSlot, newIndex + 1)
    }
  }

  record.filament_mixed_components = record.filament_mixed_components.map((value, index) => {
    const isMixed = mixedConfigBoolean(mixedFlags[index])

    if (!isMixed || typeof value !== 'string') {
      return value
    }

    return remapMixedFilamentComponentIds(value, newSlotForOldSlot)
  })
}

/**
 * Author every parallel mixed-filament vector when the client explicitly understands that schema.
 *
 * An omitted `mixedFilament` field preserves older projects byte-for-byte. Explicit nulls represent
 * physical slots and allow deleting the final virtual mix without leaving stale project arrays.
 */
function authorMixedFilamentDefinitions(
  record: Record<string, unknown>,
  filaments: SceneEditFilament[]
): void {
  const understandsMixedFilaments = filaments.some((filament) => {
    return filament.mixedFilament !== undefined
  })

  if (!understandsMixedFilaments) {
    return
  }

  record.filament_is_mixed = filaments.map((filament) => {
    return filament.mixedFilament ? '1' : '0'
  })
  record.filament_mixed_components = filaments.map((filament) => {
    return filament.mixedFilament?.componentIds.join(',') ?? ''
  })
  record.filament_mixed_sublayer_ratios = filaments.map((filament) => {
    return filament.mixedFilament?.ratios.join(',') ?? ''
  })
  record.filament_mixed_gradient = filaments.map((filament) => {
    return filament.mixedFilament?.gradient ? '1' : '0'
  })
  record.filament_mixed_gradient_range = filaments.map((filament) => {
    return filament.mixedFilament?.gradientRange.join(',') ?? ''
  })
  record.filament_mixed_gradient_curve = filaments.map((filament) => {
    const curve = filament.mixedFilament?.gradientCurve
    return curve ? serializeMixedFilamentGradientCurve(curve) : ''
  })
  record.filament_mixed_gradient_per_part = filaments.map((filament) => {
    return filament.mixedFilament?.gradientPerPart ? '1' : '0'
  })
}

/** Read the boolean encodings Bambu uses in mixed-filament project vectors. */
function mixedConfigBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

/**
 * Persist the editor's per-material dual-nozzle assignment into `project_settings.config`.
 *
 * `filament_nozzle_map` is written **verbatim** as each slot's runtime nozzle id (0 = right,
 * 1 = left), the same nozzle-id space the index parser (`extractNozzleMapping`) reads back and
 * the slicer writes. Per the nozzle-mapping invariant, do NOT remap it through
 * `physical_extruder_map`: a second inversion mis-assigns nozzles on non-identity machines (the
 * H2D's `["1","0"]`) and fails dual-nozzle offset calibration (printer error 0300-4010).
 *
 * `extruder_nozzle_stats` is rebuilt so an extruder reads "active" iff a filament is assigned to
 * it, otherwise a stale single-active reading short-circuits `extractNozzleMapping` and forces
 * every filament onto one nozzle (which is exactly how a save silently reverts to the old nozzle).
 * The rebuild is coarse (one `Standard` bucket per extruder) and only runs when the edit assigns
 * EVERY slot a nozzle, so the active/inactive set is complete; the slicer regenerates the precise
 * per-volume-type stats at the next slice. A no-op on single-nozzle projects
 * (`physical_extruder_map` shorter than 2) or when no filament carries a nozzle id.
 */
export function applyNozzleAssignmentToProjectSettings(projectSettingsJson: string, filaments: SceneEditFilament[]): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return projectSettingsJson
  }
  if (!parsed || typeof parsed !== 'object') return projectSettingsJson
  const record = parsed as Record<string, unknown>
  const physicalExtruderMap = stringArray(record.physical_extruder_map)
  if (physicalExtruderMap.length < 2) return projectSettingsJson
  if (!filaments.some((filament) => filament.nozzleId != null)) return projectSettingsJson

  const nozzleMap = Array.isArray(record.filament_nozzle_map) ? record.filament_nozzle_map.map((value) => String(value)) : []
  // Gap filler for slots this edit does not assign. A hole in `filament_nozzle_map` is NOT
  // survivable on a multi-extruder machine: BambuStudio reads the empty entry as an extruder
  // index and lands on garbage, failing the slice with "filament <name> can not be printed on
  // extruder 23075, under manual mode for multi extruder printer" (seen in production). So an
  // unassigned slot inherits its existing mapping, else the first assigned slot's nozzle.
  const fallbackNozzleId = filaments.find((filament) => filament.nozzleId != null)?.nozzleId ?? 0
  const nozzleMapEntry = (index: number): string => {
    const existing = nozzleMap[index]
    return existing != null && existing.trim() !== '' ? existing : String(fallbackNozzleId)
  }
  const extruderUsage = new Array<number>(physicalExtruderMap.length).fill(0)
  filaments.forEach((filament, index) => {
    if (filament.nozzleId == null) {
      while (nozzleMap.length <= index) nozzleMap.push(nozzleMapEntry(nozzleMap.length))
      nozzleMap[index] = nozzleMapEntry(index)
      return
    }
    while (nozzleMap.length <= index) nozzleMap.push(nozzleMapEntry(nozzleMap.length))
    nozzleMap[index] = String(filament.nozzleId)
    const extruder = sliceExtruderForNozzleId(filament.nozzleId, physicalExtruderMap)
    if (extruder != null && extruder < extruderUsage.length) extruderUsage[extruder] = (extruderUsage[extruder] ?? 0) + 1
  })
  record.filament_nozzle_map = nozzleMap
  // `extruder_nozzle_stats` is `VolumeType#count` per EXTRUDER, and the count IS how many filaments
  // that extruder feeds: BambuStudio's own save of a 3-filament dual-nozzle project reads
  // ["Standard#2","Standard#1"] for a 2/1 split, matching this. It must be rewritten whenever the
  // assignment changes: our index parser treats an extruder with count 0 as inactive and
  // short-circuits every filament onto the other nozzle, so a stale value makes a reassignment
  // silently fail to persist (pinned in `apps/api/src/lib/three-mf.test.ts`).
  //
  // The corruption seen in production came from the RETARGET recomputing this from
  // `extruder_max_nozzle_count` instead, that is a different quantity (["1","1"] on the very
  // machine whose stats are ["Standard#2","Standard#1"]), and it now preserves the value instead.
  if (filaments.every((filament) => filament.nozzleId != null)) {
    record.extruder_nozzle_stats = extruderUsage.map((count) => `Standard#${count}`)
  }

  return JSON.stringify(record)
}

/**
 * Move each `<filament id=…>`'s `group_id` in `slice_info.config` onto the slicer extruder that
 * feeds its desired runtime nozzle. slice_info's group ids are the authoritative signal the index
 * parser prefers once a project carries concrete slice usage, so they must follow the assignment or
 * a reopened sliced project shows the pre-edit nozzle. Filaments the edit does not (re)assign, and
 * files without a matching `<filament>` entry, are left byte-for-byte intact. A no-op on
 * single-nozzle projects or when no assignment inverts to a valid extruder.
 */
export function rewriteSliceInfoNozzleGroups(sliceInfoXml: string, filaments: SceneEditFilament[], physicalExtruderMap: string[]): string {
  if (physicalExtruderMap.length < 2) return sliceInfoXml
  const groupByFilamentId = new Map<number, number>()
  filaments.forEach((filament, index) => {
    if (filament.nozzleId == null) return
    const extruder = sliceExtruderForNozzleId(filament.nozzleId, physicalExtruderMap)
    if (extruder != null) groupByFilamentId.set(index + 1, extruder)
  })
  if (groupByFilamentId.size === 0) return sliceInfoXml
  return sliceInfoXml.replace(/<filament\b([^>]*?)(\/?)>(?:<\/filament>)?/g, (match, attrs: string, selfClosing: string) => {
    const idMatch = attrs.match(/\sid="(\d+)"/)
    const filamentId = Number.parseInt(idMatch?.[1] ?? '', 10)
    const group = Number.isInteger(filamentId) ? groupByFilamentId.get(filamentId) : undefined
    if (group == null) return match
    const nextAttrs = upsertXmlIntAttribute(attrs, 'group_id', group)
    return `<filament${nextAttrs}${selfClosing === '/' ? '/>' : '></filament>'}`
  })
}

/** Replace an integer XML attribute in an attribute string, or append it when absent. */
function upsertXmlIntAttribute(attrs: string, key: string, value: number): string {
  const pattern = new RegExp(`\\s${key}="[^"]*"`)
  const replacement = ` ${key}="${value}"`
  return pattern.test(attrs) ? attrs.replace(pattern, replacement) : `${attrs}${replacement}`
}
