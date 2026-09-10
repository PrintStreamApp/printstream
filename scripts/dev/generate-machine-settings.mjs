#!/usr/bin/env node
/**
 * Generates the Bambu-faithful MACHINE (printer) settings catalog consumed by the printer-settings
 * dialog in the slicer-profiles manager.
 *
 * The page/group/line LAYOUT is transcribed from BambuStudio's `TabPrinter::build_fff()` +
 * `build_unregular_pages()` (src/slic3r/GUI/Tab.cpp). The per-option METADATA comes from
 * `PrintConfig.cpp` via the shared parser in `scripts/dev/lib/bambu-config-parse.mjs`, the same
 * source of truth as the process and filament catalogs. Re-run to update.
 *
 * ONE DELIBERATE DIVERGENCE from BambuStudio's UI: it renders the per-extruder options as a page
 * PER extruder, built at runtime from the machine's extruder count. Those options are vector
 * config values indexed by extruder, so a preset editor shows them once, as a single "Extruder"
 * page: the dialog edits the stored preset, not a live machine, and duplicating identical pages
 * would say nothing extra.
 *
 * Usage:
 *   node scripts/dev/generate-machine-settings.mjs [--src <bambustudio-src>]
 *
 * Output: packages/shared/src/generated/machine-settings.generated.ts
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
 * Transcribed from TabPrinter::build_fff() and build_unregular_pages(). Each group is
 * [groupTitle, ...lines]; a line is a key string, or { key, code, height } for a multiline
 * G-code editor. Commented-out groups in the source (Capabilities, Firmware, Dependencies) are
 * omitted, as are the bed-shape and preview widgets, which are bespoke controls rather than
 * plain config options.
 */
const LAYOUT = [
  ['Basic information', [
    ['Printable space', ['printable_height', 'best_object_pos']],
    // Transcribed from the LIVE lines of TabPrinter::build_fff's "Advanced" optgroup. BambuStudio
    // has commented several neighbours out (`silent_mode`, `spaghetti_detector`, and
    // `single_extruder_multi_material`'s whole `#if 0` block), and a commented-out option is not
    // merely unused, it has no `def->label` either, so including one rendered a nameless switch
    // that changed a setting the slicer ignores. `silent_mode` is still READ (it decides whether
    // the motion limits get a Silent column, see `machineSupportsSilentMode`); BambuStudio just
    // does not let anyone edit it here, and neither do we.
    ['Advanced', [
      'printer_structure', 'gcode_flavor', { key: 'thumbnail_size', fullWidth: true },
      'scan_first_layer', 'print_in_clockwise', 'use_relative_e_distances', 'use_firmware_retraction',
      'bed_temperature_formula', 'machine_load_filament_time',
      'machine_unload_filament_time', 'machine_switch_extruder_time', 'machine_hotend_change_time'
    ]],
    ['Extruder Clearance', [
      'extruder_clearance_max_radius', 'extruder_clearance_dist_to_rod',
      'extruder_clearance_height_to_rod', 'extruder_clearance_height_to_lid'
    ]],
    ['Accessory', [
      'nozzle_type', 'auxiliary_fan', 'fan_direction', 'support_chamber_temp_control',
      'support_air_filtration', 'cooling_filter_enabled'
    ]]
  ]],
  ['Extruder', [
    ['Basic information', ['extruder_type', 'nozzle_diameter', 'default_nozzle_volume_type', 'nozzle_volume', 'extruder_printable_height']],
    ['Layer height limits', ['min_layer_height', 'max_layer_height']],
    ['Position', ['extruder_offset']],
    ['Retraction', [
      'retraction_length', 'z_hop', 'retract_lift_above', 'retract_lift_below', 'z_hop_types',
      'retraction_speed', 'deretraction_speed', 'retract_restart_extra', 'retraction_minimum_travel',
      'retract_when_changing_layer', 'wipe', 'wipe_distance', 'retract_before_wipe'
    ]],
    ['Retraction when switching material', [
      'retract_length_toolchange', 'retract_restart_extra_toolchange',
      'long_retractions_when_cut', 'retraction_distances_when_cut'
    ]]
  ]],
  ['Motion ability', [
    ['Speed limitation', ['machine_max_speed_x', 'machine_max_speed_y', 'machine_max_speed_z', 'machine_max_speed_e']],
    ['Acceleration limitation', [
      'machine_max_acceleration_x', 'machine_max_acceleration_y', 'machine_max_acceleration_z',
      'machine_max_acceleration_e', 'machine_max_acceleration_extruding',
      'machine_max_acceleration_retracting', 'machine_max_acceleration_travel'
    ]],
    ['Jerk limitation', ['machine_max_jerk_x', 'machine_max_jerk_y', 'machine_max_jerk_z', 'machine_max_jerk_e']],
    ['Minimum feedrates', ['machine_min_extruding_rate', 'machine_min_travel_rate']]
  ]],
  ['Machine gcode', [
    ['Machine start G-code', [{ key: 'machine_start_gcode', code: true, height: 15 }]],
    ['Machine end G-code', [{ key: 'machine_end_gcode', code: true, height: 15 }]],
    ['Before layer change G-code', [{ key: 'before_layer_change_gcode', code: true, height: 5 }]],
    ['Layer change G-code', [{ key: 'layer_change_gcode', code: true, height: 5 }]],
    ['Time lapse G-code', [{ key: 'time_lapse_gcode', code: true, height: 5 }]],
    ['Change filament G-code', [{ key: 'change_filament_gcode', code: true, height: 5 }]],
    ['Pause G-code', [{ key: 'machine_pause_gcode', code: true, height: 5 }]],
    ['Template Custom G-code', [{ key: 'template_custom_gcode', code: true, height: 5 }]]
  ]],
  ['Notes', [
    ['Notes', [{ key: 'printer_notes', code: true, height: 25 }]]
  ]]
]

/**
 * The XYZE machine limits, which the shared parser cannot see: BambuStudio declares them in a loop
 * (`this->add("machine_max_speed_" + axis.name, coFloats)`), not as literal keys. Synthesized here
 * from that loop body so they carry their real NUMERIC type: a numeric option left to the parser's
 * `string` fallback loses its bounds and reads as changed against any preset that spells the value
 * differently, which is the phantom-changed bug this repo has already fixed once.
 */
function axisLimitOptions() {
  const options = {}
  const axes = ['X', 'Y', 'Z', 'E']
  const families = [
    { prefix: 'machine_max_speed_', label: 'Maximum speed', tooltip: (axis) => `Maximum speed of ${axis} axis`, sidetext: 'mm/s' },
    { prefix: 'machine_max_acceleration_', label: 'Maximum acceleration', tooltip: (axis) => `Maximum acceleration of ${axis} axis`, sidetext: 'mm/s²' },
    { prefix: 'machine_max_jerk_', label: 'Maximum jerk', tooltip: (axis) => `Maximum jerk of ${axis} axis`, sidetext: 'mm/s' }
  ]
  for (const family of families) {
    for (const axis of axes) {
      options[`${family.prefix}${axis.toLowerCase()}`] = {
        // `coFloats` -> field type `float` + the vector flag, exactly as mapType() would emit it.
        type: 'float',
        vector: true,
        label: `${family.label} ${axis}`,
        tooltip: family.tooltip(axis),
        sidetext: family.sidetext,
        min: 0,
        mode: 'simple'
      }
    }
  }
  return options
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
  const axisLimits = axisLimitOptions()

  const missing = []
  const pages = LAYOUT.map(([title, groups]) => ({
    id: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    title,
    groups: groups.map(([groupTitle, lines]) => ({
      title: groupTitle,
      lines: lines.map((line) => (typeof line === 'string'
        ? { keys: [line] }
        : { keys: [line.key], fullWidth: line.fullWidth, code: line.code, height: line.height }))
    }))
  }))

  const options = {}
  const seen = new Set()
  for (const [, groups] of LAYOUT) {
    for (const [, lines] of groups) {
      for (const line of lines) {
        const key = typeof line === 'string' ? line : line.key
        if (seen.has(key)) continue
        seen.add(key)
        const synthesized = axisLimits[key]
        if (synthesized) { options[key] = synthesized; continue }
        const entry = blocks.get(key)
        if (!entry) {
          missing.push(key)
          options[key] = { type: 'string', label: key, tooltip: '', mode: 'simple' }
          continue
        }
        // The `full_label` fallback that names the machine limits lives in `parseBlock`. See the
        // note there; without it five acceleration/feedrate fields render as unnamed number boxes.
        options[key] = parseBlock(entry.coType, entry.block)
      }
    }
  }

  resolveEnums(options, varToKey, content)

  for (const [, groups] of LAYOUT) {
    for (const [, lines] of groups) {
      for (const line of lines) {
        if (typeof line === 'object') {
          const option = options[line.key]
          if (line.fullWidth) option.fullWidth = true
          if (line.code) option.isCode = true
          if (line.height) option.height = line.height
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
  const outPath = path.join(outDir, 'machine-settings.generated.ts')
  const header = `/**
 * GENERATED FILE - DO NOT EDIT.
 * Produced by scripts/dev/generate-machine-settings.mjs from the BambuStudio
 * source (Tab.cpp TabPrinter layout + PrintConfig.cpp metadata). Re-run the
 * generator to update. See packages/shared/src/process-settings.ts for the
 * consuming types (shared with the process and filament catalogs).
 */
import type { ProcessSettingsCatalog } from '../process-settings.js'

export const machineSettingsCatalog: ProcessSettingsCatalog = ${JSON.stringify(catalog, null, 2)}
`
  writeFileSync(outPath, header)
  console.log(`Wrote ${outPath}`)
  console.log(`Pages: ${pages.length}, options: ${Object.keys(options).length}, missing: ${missing.length}`)
}

main()
