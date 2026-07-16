#!/usr/bin/env node
/**
 * Generates the Bambu-faithful process (quality) settings catalog consumed by
 * the process-settings editor dialog.
 *
 * The page/group/line LAYOUT is transcribed verbatim from BambuStudio's
 * `TabPrint::build()` (src/slic3r/GUI/Tab.cpp). The per-option METADATA
 * (type, label, tooltip, enum values/labels, units, min/max, mode, default,
 * gui flags) is extracted directly from `PrintConfig.cpp`
 * (src/libslic3r/PrintConfig.cpp) via the shared parser in
 * `scripts/dev/lib/bambu-config-parse.mjs` so the catalog stays faithful to the
 * slicer. The sibling `generate-filament-settings.mjs` shares that parser.
 *
 * Usage:
 *   node scripts/dev/generate-process-settings.mjs [--src <bambustudio-src>]
 *
 * Output: packages/shared/src/generated/process-settings.generated.ts
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
 * The process tab layout, transcribed from TabPrint::build().
 * Each group is [groupTitle, ...lines]; a line is either a string key
 * (single-option line) or { line: label, keys: [...] } (multi-option line)
 * or { key, fullWidth, code, height } for special single lines.
 * Commented-out and #if 0 / #ifdef-guarded lines from the source are omitted.
 */
const LAYOUT = [
  ['Quality', [
    ['Layer height', ['layer_height', 'initial_layer_print_height', 'enable_mixed_color_sublayer']],
    ['Line width', ['line_width', 'initial_layer_line_width', 'outer_wall_line_width', 'inner_wall_line_width', 'top_surface_line_width', 'sparse_infill_line_width', 'internal_solid_infill_line_width', 'support_line_width']],
    ['Seam', ['seam_position', 'seam_placement_away_from_overhangs', 'seam_gap', 'seam_slope_conditional', 'scarf_angle_threshold', 'seam_slope_entire_loop', 'seam_slope_steps', 'seam_slope_inner_walls', 'override_filament_scarf_seam_setting', 'seam_slope_type', 'seam_slope_start_height', 'seam_slope_gap', 'seam_slope_min_length', 'wipe_speed', 'role_base_wipe_speed']],
    ['Precision', ['slice_closing_radius', 'resolution', 'enable_arc_fitting', 'xy_hole_compensation', 'xy_contour_compensation', 'enable_circle_compensation', 'circle_compensation_manual_offset', 'elefant_foot_compensation', 'precise_outer_wall', 'precise_z_height']],
    ['Ironing', ['ironing_type', 'ironing_pattern', 'ironing_speed', 'ironing_flow', 'ironing_spacing', 'ironing_inset', 'ironing_direction']],
    ['Wall generator', ['wall_generator', 'wall_transition_angle', 'wall_transition_filter_deviation', 'wall_transition_length', 'wall_distribution_count', 'min_bead_width', 'min_feature_size']],
    ['Advanced', ['wall_sequence', 'is_infill_first', 'bridge_flow', 'thick_bridges', 'print_flow_ratio', 'top_solid_infill_flow_ratio', 'initial_layer_flow_ratio', 'top_one_wall_type', 'top_area_threshold', 'only_one_wall_first_layer', 'detect_overhang_wall', 'smooth_speed_discontinuity_area', 'smooth_coefficient', 'reduce_crossing_wall', 'max_travel_detour_distance', 'avoid_crossing_wall_includes_support', 'z_direction_outwall_speed_continuous']]
  ]],
  ['Strength', [
    ['Walls', ['wall_loops', 'alternate_extra_wall', 'embedding_wall_into_infill', 'detect_thin_wall']],
    ['Top/bottom shells', ['interface_shells', 'top_surface_pattern', 'top_surface_density', 'top_shell_layers', 'top_shell_thickness', 'top_color_penetration_layers', 'bottom_surface_pattern', 'bottom_surface_density', 'bottom_shell_layers', 'bottom_shell_thickness', 'bottom_color_penetration_layers', 'infill_instead_top_bottom_surfaces', 'internal_solid_infill_pattern']],
    ['Sparse infill', ['sparse_infill_density', 'fill_multiline', 'sparse_infill_pattern', 'locked_skin_infill_pattern', 'skin_infill_density', 'locked_skeleton_infill_pattern', 'skeleton_infill_density', 'infill_lock_depth', 'skin_infill_depth', 'skin_infill_line_width', 'skeleton_infill_line_width', 'symmetric_infill_y_axis', 'infill_shift_step', 'sparse_infill_lattice_angle_1', 'sparse_infill_lattice_angle_2', 'infill_rotate_step', 'sparse_infill_anchor', 'sparse_infill_anchor_max', 'filter_out_gap_fill']],
    ['Advanced', ['infill_wall_overlap', 'monotonic_travel_into_wall', 'infill_direction', 'bridge_angle', 'minimum_sparse_infill_area', 'infill_combination', 'detect_narrow_internal_solid_infill', 'ensure_vertical_shell_thickness', 'detect_floating_vertical_shell']]
  ]],
  ['Speed', [
    ['Initial layer speed', ['initial_layer_speed', 'initial_layer_infill_speed']],
    ['Other layers speed', ['outer_wall_speed', 'inner_wall_speed', 'small_perimeter_speed', 'small_perimeter_threshold', 'sparse_infill_speed', 'internal_solid_infill_speed', 'vertical_shell_speed', 'top_surface_speed', 'enable_overhang_speed',
      { line: 'Overhang speed', keys: ['overhang_1_4_speed', 'overhang_2_4_speed', 'overhang_3_4_speed', 'overhang_4_4_speed', 'overhang_totally_speed'] },
      'enable_height_slowdown', 'slowdown_start_height', 'slowdown_start_speed', 'slowdown_start_acc', 'slowdown_end_height', 'slowdown_end_speed', 'slowdown_end_acc', 'bridge_speed', 'gap_infill_speed', 'support_speed', 'support_interface_speed']],
    ['Travel speed', ['travel_speed']],
    ['Acceleration', ['default_acceleration', 'travel_acceleration', 'travel_short_distance_acceleration', 'initial_layer_travel_acceleration', 'initial_layer_acceleration', 'outer_wall_acceleration', 'inner_wall_acceleration', 'top_surface_acceleration', 'sparse_infill_acceleration', 'accel_to_decel_enable', 'accel_to_decel_factor']],
    ['Jerk(XY)', ['default_jerk', 'outer_wall_jerk', 'inner_wall_jerk', 'infill_jerk', 'top_surface_jerk', 'initial_layer_jerk', 'travel_jerk']]
  ]],
  ['Support', [
    ['Support', ['enable_support', 'support_type', 'support_style', 'support_threshold_angle', 'support_on_build_plate_only', 'support_critical_regions_only', 'support_remove_small_overhang']],
    ['Raft', ['raft_layers', 'raft_contact_distance']],
    ['Support filament', ['support_filament', 'support_interface_filament', 'support_interface_not_for_body']],
    ['Support ironing', ['enable_support_ironing', 'support_ironing_pattern', 'support_ironing_speed', 'support_ironing_flow', 'support_ironing_spacing', 'support_ironing_inset', 'support_ironing_direction']],
    ['Advanced', ['raft_first_layer_density', 'raft_first_layer_expansion', 'tree_support_wall_count', 'support_top_z_distance', 'support_bottom_z_distance', 'support_base_pattern', 'support_base_pattern_spacing', 'support_angle', 'support_interface_top_layers', 'support_interface_bottom_layers', 'support_interface_pattern', 'support_interface_spacing', 'support_bottom_interface_spacing', 'support_expansion', 'support_object_xy_distance', 'top_z_overrides_xy_distance', 'support_object_first_layer_gap', 'bridge_no_support', 'max_bridge_length', 'independent_support_layer_height']],
    ['Tree Support', ['tree_support_branch_distance', 'tree_support_branch_diameter', 'tree_support_branch_angle', 'tree_support_branch_diameter_angle']]
  ]],
  ['Others', [
    ['Bed adhension', ['skirt_loops', 'skirt_height', 'skirt_distance', 'brim_type', 'brim_width', 'brim_object_gap']],
    ['Prime tower', ['enable_prime_tower', 'prime_tower_skip_points', 'prime_tower_enable_framework', 'prime_tower_width', 'prime_tower_max_speed', 'prime_tower_brim_width', 'prime_tower_infill_gap', 'prime_tower_rib_wall', 'prime_tower_extra_rib_length', 'prime_tower_rib_width', 'prime_tower_fillet_wall', 'enable_tower_interface_features']],
    ['Flush options', ['flush_into_infill', 'flush_into_objects', 'flush_into_support']],
    ['Special mode', ['slicing_mode', 'print_sequence', 'spiral_mode', 'spiral_mode_smooth', 'spiral_mode_max_xy_smoothing', 'timelapse_type', 'fuzzy_skin', 'fuzzy_skin_mode', 'fuzzy_skin_noise_type', 'fuzzy_skin_point_distance', 'fuzzy_skin_thickness', 'fuzzy_skin_scale', 'fuzzy_skin_octaves', 'fuzzy_skin_persistence', 'fuzzy_skin_first_layer']],
    ['Advanced', ['enable_wrapping_detection', 'enable_order_independent_overlap_carving', 'interlocking_beam', 'mmu_segmented_region_interlocking_depth', 'interlocking_beam_width', 'interlocking_orientation', 'interlocking_beam_layer_count', 'interlocking_depth', 'interlocking_boundary_avoidance', 'sparse_infill_filament', 'solid_infill_filament', 'wall_filament']],
    ['G-code output', ['reduce_infill_retraction_mode', 'gcode_add_line_number', 'exclude_object', { key: 'filename_format', fullWidth: true }]],
    ['Post-processing scripts', [{ key: 'post_process', fullWidth: true, code: true, height: 15 }]],
    ['Notes', [{ key: 'process_notes', fullWidth: true, height: 25 }]]
  ]]
]

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
          if (!entry) { missing.push(key); options[key] = { type: 'string', label: key, tooltip: '', mode: 'simple' }; continue }
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
  const outPath = path.join(outDir, 'process-settings.generated.ts')
  const header = `/**
 * GENERATED FILE - DO NOT EDIT.
 * Produced by scripts/dev/generate-process-settings.mjs from the BambuStudio
 * source (Tab.cpp layout + PrintConfig.cpp metadata). Re-run the generator to
 * update. See packages/shared/src/process-settings.ts for the consuming types.
 */
import type { ProcessSettingsCatalog } from '../process-settings.js'

export const processSettingsCatalog: ProcessSettingsCatalog = ${JSON.stringify(catalog, null, 2)}
`
  writeFileSync(outPath, header)
  const optionCount = Object.keys(options).length
  console.log(`Wrote ${outPath}`)
  console.log(`Pages: ${pages.length}, options: ${optionCount}, missing: ${missing.length}`)
}

main()
