#!/usr/bin/env node
/**
 * Generates the Bambu-faithful FILAMENT (material) settings catalog consumed by
 * the filament-settings editor dialog (the material "tune" dialog next to the
 * trashbin in the slice/editor material list).
 *
 * The page/group/line LAYOUT is transcribed verbatim from BambuStudio's
 * `TabFilament::build()` + `add_filament_overrides_page()` (src/slic3r/GUI/Tab.cpp).
 * The per-option METADATA is extracted from `PrintConfig.cpp` via the shared parser
 * in `scripts/dev/lib/bambu-config-parse.mjs` (same source of truth as the process
 * catalog). Re-run to update.
 *
 * Usage:
 *   node scripts/dev/generate-filament-settings.mjs [--src <bambustudio-src>]
 *
 * Output: packages/shared/src/generated/filament-settings.generated.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { indexOptionBlocks, parseBlock, resolveEnums } from './lib/bambu-config-parse.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..')

function parseArgs(argv) {
  let src = path.join(repoRoot, 'tmp', 'bambustudio-src')
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--src') src = path.resolve(argv[++i])
  }
  return { src }
}

/**
 * The filament tab layout, transcribed from TabFilament::build() +
 * add_filament_overrides_page(). Each group is [groupTitle, ...lines]; a line is
 * either a string key (single-option line), { line: label, keys: [...] } (multi-option
 * line), or { key, fullWidth, code, height } for special single lines. Commented-out
 * and #if 0 lines from the source are omitted.
 */
const LAYOUT = [
  ['Filament', [
    ['Basic information', ['filament_type', 'filament_vendor', 'filament_soluble', 'filament_is_support', 'impact_strength_z', 'required_nozzle_HRC', 'default_filament_colour', 'filament_diameter', 'filament_adhesiveness_category', 'filament_metal_stickiness', 'filament_flow_ratio', 'enable_pressure_advance', 'pressure_advance', 'filament_density', 'filament_shrink', 'filament_velocity_adaptation_factor', 'filament_cost', 'temperature_vitrification', 'filament_printable', 'filament_cooling_before_tower', 'filament_tower_interface_pre_extrusion_dist', 'filament_tower_interface_pre_extrusion_length', 'filament_tower_ironing_area', 'filament_tower_interface_purge_volume', 'filament_tower_interface_print_temp',
      { line: 'Filament prime volume', keys: ['filament_prime_volume', 'filament_prime_volume_nc'] },
      { line: 'Filament ramming length', keys: ['filament_change_length', 'filament_change_length_nc'] },
      { line: 'Travel time after ramming', keys: ['filament_ramming_travel_time', 'filament_ramming_travel_time_nc'] },
      { line: 'Precooling target temperature', keys: ['filament_pre_cooling_temperature', 'filament_pre_cooling_temperature_nc'] },
      { line: 'Recommended nozzle temperature', keys: ['nozzle_temperature_range_low', 'nozzle_temperature_range_high'] }]],
    ['Print temperature', ['chamber_temperatures',
      { line: 'Bambu Cool Plate SuperTack', keys: ['supertack_plate_temp_initial_layer', 'supertack_plate_temp'] },
      { line: 'Cool Plate', keys: ['cool_plate_temp_initial_layer', 'cool_plate_temp'] },
      { line: 'Engineering Plate', keys: ['eng_plate_temp_initial_layer', 'eng_plate_temp'] },
      { line: 'Smooth PEI Plate / High Temp Plate', keys: ['hot_plate_temp_initial_layer', 'hot_plate_temp'] },
      { line: 'Textured PEI Plate', keys: ['textured_plate_temp_initial_layer', 'textured_plate_temp'] },
      { line: 'Nozzle', keys: ['nozzle_temperature_initial_layer', 'nozzle_temperature'] }]],
    ['Volumetric speed limitation', ['filament_adaptive_volumetric_speed', 'filament_max_volumetric_speed',
      { line: 'Ramming volumetric speed', keys: ['filament_ramming_volumetric_speed', 'filament_ramming_volumetric_speed_nc'] }]],
    ['Filament scarf seam settings', ['filament_scarf_seam_type', 'filament_scarf_height', 'filament_scarf_gap', 'filament_scarf_length']]
  ]],
  ['Cooling', [
    ['Part cooling fan', [
      { line: 'Initial layer fan', keys: ['close_fan_the_first_x_layers', 'first_x_layer_part_fan_speed'] },
      { line: 'Linear ramp up to', keys: ['full_fan_speed_layer'] },
      { line: 'Min fan speed threshold', keys: ['fan_min_speed', 'fan_cooling_layer_time'] },
      { line: 'Max fan speed threshold', keys: ['fan_max_speed', 'slow_down_layer_time'] },
      'reduce_fan_stop_start_freq', 'slow_down_for_layer_cooling', 'no_slow_down_for_cooling_on_outwalls', 'cooling_slowdown_logic', 'cooling_perimeter_transition_distance', 'slow_down_min_speed', 'enable_overhang_bridge_fan', 'overhang_fan_threshold', 'overhang_threshold_participating_cooling', 'overhang_fan_speed', 'pre_start_fan_time', 'ironing_fan_speed']],
    ['Auxiliary part cooling fan', [
      { line: 'Initial layer fan', keys: ['close_additional_fan_first_x_layers', 'first_x_layer_fan_speed'] },
      { line: 'Linear ramp up', keys: ['additional_fan_full_speed_layer', 'additional_cooling_fan_speed'] }]],
    ['Exhaust fan', ['activate_air_filtration',
      { line: 'During print', keys: ['during_print_exhaust_fan_speed'] },
      { line: 'Complete print', keys: ['complete_print_exhaust_fan_speed'] }]]
  ]],
  ['Setting Overrides', [
    ['Retraction', ['filament_retraction_length', 'filament_z_hop', 'filament_z_hop_types', 'filament_retraction_speed', 'filament_deretraction_speed', 'filament_retract_length_nc', 'filament_retract_restart_extra', 'filament_retraction_minimum_travel', 'filament_retract_when_changing_layer', 'filament_wipe', 'filament_wipe_distance', 'filament_retract_before_wipe', 'filament_long_retractions_when_cut', 'filament_retraction_distances_when_cut']],
    ['Speed', ['override_process_overhang_speed', 'filament_enable_overhang_speed', 'filament_overhang_1_4_speed', 'filament_overhang_2_4_speed', 'filament_overhang_3_4_speed', 'filament_overhang_4_4_speed', 'filament_overhang_totally_speed', 'filament_bridge_speed']]
  ]],
  ['Advanced', [
    ['Filament start G-code', [{ key: 'filament_start_gcode', fullWidth: true, code: true, height: 15 }]],
    ['Filament end G-code', [{ key: 'filament_end_gcode', fullWidth: true, code: true, height: 15 }]]
  ]],
  ['Notes', [
    ['Notes', [{ key: 'filament_notes', fullWidth: true, height: 25 }]]
  ]],
  ['Multi Filament', [
    ['Multi Filament', ['filament_flush_temp', 'filament_flush_temp_fast', 'filament_flush_volumetric_speed', 'long_retractions_when_ec', 'retraction_distances_when_ec']]
  ]]
]

/**
 * The "Setting Overrides" keys (`filament_retraction_length`, `filament_overhang_1_4_speed`, ...)
 * are NOT defined with their own `this->add(...)` — BambuStudio builds them in a loop that copies
 * the base printer/process option's metadata (label/tooltip/enum/min/max/type) under a `filament_`
 * prefix as a nullable per-filament override (PrintConfig.cpp `filament_extruder_override_keys` /
 * `filament_overhang_override_keys`). We mirror that: parse the BASE key's block, then set the mode
 * BambuStudio assigns the override. Base key = the option key minus the `filament_` prefix.
 */
const OVERRIDE_SIMPLE_MODE = new Set([
  'filament_retraction_length',
  'filament_z_hop',
  'filament_long_retractions_when_cut',
  'filament_retraction_distances_when_cut'
])

/** Build an override option from its base option's parsed metadata, or null when the base is absent. */
function resolveOverrideOption(key, blocks) {
  if (!key.startsWith('filament_')) return null
  const baseKey = key.slice('filament_'.length)
  const entry = blocks.get(baseKey)
  if (!entry) return null
  const option = parseBlock(entry.coType, entry.block)
  option.mode = OVERRIDE_SIMPLE_MODE.has(key) ? 'simple' : 'advanced'
  return option
}

function main() {
  const { src } = parseArgs(process.argv.slice(2))
  const printConfigPath = path.join(src, 'src', 'libslic3r', 'PrintConfig.cpp')
  let content
  try {
    content = readFileSync(printConfigPath, 'utf8')
  } catch {
    console.error(`Could not read ${printConfigPath}. Pass --src <bambustudio-src>.`)
    process.exit(1)
  }

  const { blocks, varToKey } = indexOptionBlocks(content)

  const missing = []
  const pages = LAYOUT.map(([title, groups]) => ({
    id: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    title,
    groups: groups.map(([groupTitle, lines]) => ({
      title: groupTitle,
      lines: lines.map((line) => {
        if (typeof line === 'string') {
          return { keys: [line] }
        }
        if (line.keys) {
          return { label: line.line, keys: line.keys }
        }
        return { keys: [line.key], fullWidth: line.fullWidth, code: line.code, height: line.height }
      })
    }))
  }))

  const options = {}
  const seen = new Set()
  for (const [, groups] of LAYOUT) {
    for (const [, lines] of groups) {
      for (const line of lines) {
        const keys = typeof line === 'string' ? [line] : (line.keys ?? [line.key])
        for (const key of keys) {
          if (seen.has(key)) continue
          seen.add(key)
          const entry = blocks.get(key)
          if (!entry) {
            // "Setting Overrides" keys copy their base option's metadata (see resolveOverrideOption).
            const override = resolveOverrideOption(key, blocks)
            if (override) { options[key] = override; continue }
            missing.push(key); options[key] = { type: 'string', label: key, tooltip: '', mode: 'simple' }; continue
          }
          options[key] = parseBlock(entry.coType, entry.block)
        }
      }
    }
  }

  resolveEnums(options, varToKey, content)

  // Layout-level full_width / code / height overrides.
  for (const [, groups] of LAYOUT) {
    for (const [, lines] of groups) {
      for (const line of lines) {
        if (typeof line === 'object' && !line.keys && line.key) {
          const o = options[line.key]
          if (line.fullWidth) o.fullWidth = true
          if (line.code) o.isCode = true
          if (line.height) o.height = line.height
        }
      }
    }
  }

  if (missing.length) {
    console.warn(`WARNING: ${missing.length} keys not found in PrintConfig.cpp:`, missing.join(', '))
  }

  const catalog = { pages, options }
  const outDir = path.join(repoRoot, 'packages', 'shared', 'src', 'generated')
  mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, 'filament-settings.generated.ts')
  const header = `/**
 * GENERATED FILE - DO NOT EDIT.
 * Produced by scripts/dev/generate-filament-settings.mjs from the BambuStudio
 * source (Tab.cpp TabFilament layout + PrintConfig.cpp metadata). Re-run the
 * generator to update. See packages/shared/src/filament-settings.ts for the
 * consuming types (shared with the process catalog).
 */
import type { ProcessSettingsCatalog } from '../process-settings.js'

export const filamentSettingsCatalog: ProcessSettingsCatalog = ${JSON.stringify(catalog, null, 2)}
`
  writeFileSync(outPath, header)
  const optionCount = Object.keys(options).length
  console.log(`Wrote ${outPath}`)
  console.log(`Pages: ${pages.length}, options: ${optionCount}, missing: ${missing.length}`)
}

main()
