#!/usr/bin/env node
/**
 * Generates the Bambu-faithful process (quality) settings catalog consumed by
 * the process-settings editor dialog.
 *
 * The page/group/line LAYOUT is transcribed verbatim from BambuStudio's
 * `TabPrint::build()` (src/slic3r/GUI/Tab.cpp). The per-option METADATA
 * (type, label, tooltip, enum values/labels, units, min/max, mode, default,
 * gui flags) is extracted directly from `PrintConfig.cpp`
 * (src/libslic3r/PrintConfig.cpp) so the catalog stays faithful to the slicer.
 *
 * Usage:
 *   node scripts/dev/generate-process-settings.mjs [--src <bambustudio-src>]
 *
 * Output: packages/shared/src/generated/process-settings.generated.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

const MODE_MAP = { comSimple: 'simple', comAdvanced: 'advanced', comDevelop: 'develop' }

/**
 * Map a BambuStudio ConfigOption C++ type to a UI field type + vector flag.
 */
function mapType(coType) {
  const vector = /s$|sNullable$/.test(coType) && coType !== 'coFloatOrPercent'
  const base = coType.replace(/Nullable$/, '').replace(/s$/, '')
  let fieldType
  switch (base) {
    case 'coBool': fieldType = 'bool'; break
    case 'coInt': fieldType = 'int'; break
    case 'coFloat': fieldType = 'float'; break
    case 'coPercent': fieldType = 'percent'; break
    case 'coFloatOrPercent': fieldType = 'floatOrPercent'; break
    case 'coEnum': fieldType = 'enum'; break
    case 'coString': fieldType = 'string'; break
    case 'coPoint': fieldType = 'point'; break
    case 'coPoint3': fieldType = 'point'; break
    default: fieldType = 'string'; break
  }
  return { fieldType, vector }
}

/** Remove preprocessor directive lines; drop `#if 0`/`#if !1` blocks entirely, keep other directives' content. */
function stripPreprocessor(code) {
  const lines = code.split('\n')
  const out = []
  let skipDepth = 0
  for (const line of lines) {
    const t = line.trim()
    if (/^#\s*if\s+(0|!\s*1)\b/.test(t)) { skipDepth++; continue }
    if (skipDepth > 0) {
      if (/^#\s*if/.test(t)) skipDepth++
      else if (/^#\s*endif/.test(t)) skipDepth--
      continue
    }
    if (/^#/.test(t)) continue
    out.push(line)
  }
  return out.join('\n')
}

/** Split C++ code into statements on top-level `;`, respecting string literals and line comments. */
function splitStatements(rawCode) {
  const code = stripPreprocessor(rawCode)
  const stmts = []
  let cur = ''
  let i = 0
  let inStr = false
  let strCh = ''
  while (i < code.length) {
    const c = code[i]
    if (inStr) {
      cur += c
      if (c === '\\') { cur += code[i + 1] ?? ''; i += 2; continue }
      if (c === strCh) inStr = false
      i++
      continue
    }
    if (c === '"') { inStr = true; strCh = c; cur += c; i++; continue }
    if (c === '/' && code[i + 1] === '/') { while (i < code.length && code[i] !== '\n') i++; continue }
    if (c === '/' && code[i + 1] === '*') { i += 2; while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++; i += 2; continue }
    if (c === ';') { stmts.push(cur); cur = ''; i++; continue }
    cur += c
    i++
  }
  if (cur.trim()) stmts.push(cur)
  return stmts
}

/** Concatenate adjacent C++ string literals in an expression, decoding escapes; ignores L() wrappers. */
function extractString(expr) {
  const parts = []
  let i = 0
  let inStr = false
  let cur = ''
  while (i < expr.length) {
    const c = expr[i]
    if (inStr) {
      if (c === '\\') {
        const n = expr[i + 1]
        const map = { n: '\n', t: '\t', r: '', '"': '"', "'": "'", '\\': '\\' }
        cur += Object.hasOwn(map, n) ? map[n] : n
        i += 2
        continue
      }
      if (c === '"') { inStr = false; parts.push(cur); cur = ''; i++; continue }
      cur += c
      i++
      continue
    }
    if (c === '"') { inStr = true; i++; continue }
    i++
  }
  return parts.join('')
}

function parseNumber(expr) {
  const m = /-?\d+(?:\.\d+)?/.exec(expr)
  return m ? Number(m[0]) : undefined
}

/** Parse a single option-definition block's statements into metadata. */
function parseBlock(coType, block) {
  const { fieldType, vector } = mapType(coType)
  const opt = {
    type: fieldType,
    vector,
    label: '',
    tooltip: '',
    sidetext: '',
    category: '',
    enumValues: [],
    enumLabels: [],
    mode: 'simple',
    fullWidth: false,
    isCode: false,
    height: undefined,
    min: undefined,
    max: undefined,
    default: undefined,
    guiType: undefined
  }
  for (const stmt of splitStatements(block)) {
    const s = stmt.trim()
    if (!s.startsWith('def->')) continue
    if (s.startsWith('def->label')) opt.label = extractString(s)
    else if (s.startsWith('def->tooltip')) opt.tooltip = extractString(s)
    else if (s.startsWith('def->sidetext')) opt.sidetext = extractString(s)
    else if (s.startsWith('def->category')) opt.category = extractString(s)
    else if (s.startsWith('def->enum_values.push_back') || s.startsWith('def->enum_values.emplace_back')) opt.enumValues.push(extractString(s))
    else if (s.startsWith('def->enum_labels.push_back') || s.startsWith('def->enum_labels.emplace_back')) opt.enumLabels.push(extractString(s))
    else if (/^def->enum_values\s*=/.test(s)) {
      const ref = /(\w+)->enum_values/.exec(s.split('=')[1] ?? '')
      if (ref) opt.enumRefVar = ref[1]
    } else if (s.startsWith('def->mode')) {
      const m = /com\w+/.exec(s)
      if (m) opt.mode = MODE_MAP[m[0]] ?? 'simple'
    } else if (s.startsWith('def->min')) opt.min = parseNumber(s.split('=')[1] ?? '')
    else if (s.startsWith('def->max') && !s.startsWith('def->max_literal')) opt.max = parseNumber(s.split('=')[1] ?? '')
    else if (s.startsWith('def->full_width')) opt.fullWidth = /true/.test(s)
    else if (s.startsWith('def->is_code')) opt.isCode = /true/.test(s)
    else if (s.startsWith('def->height')) opt.height = parseNumber(s.split('=')[1] ?? '')
    else if (s.startsWith('def->gui_type')) {
      const m = /GUIType::(\w+)/.exec(s)
      if (m) opt.guiType = m[1]
    } else if (s.startsWith('def->set_default_value')) {
      if (fieldType === 'enum') {
        // Enum defaults reference a C++ symbol (e.g. ipRectilinear or
        // WallSequence::InnerOuter). Capture it now and resolve to the
        // serialized string via the s_keys_map_<Type> tables in main().
        const em = /ConfigOptionEnum<(\w+)>\s*\(\s*([\w:]+)\s*\)/.exec(s)
        if (em) { opt.enumDefaultType = em[1]; opt.enumDefaultSymbol = em[2] }
      } else {
        opt.default = parseDefault(s, fieldType)
      }
    }
  }
  // Drop empties to keep generated data lean.
  if (!opt.sidetext) delete opt.sidetext
  if (!opt.category) delete opt.category
  if (opt.enumValues.length === 0 && !opt.enumRefVar) { delete opt.enumValues; delete opt.enumLabels }
  if (opt.min === undefined) delete opt.min
  if (opt.max === undefined) delete opt.max
  if (opt.height === undefined) delete opt.height
  if (opt.default === undefined) delete opt.default
  if (!opt.guiType) delete opt.guiType
  if (!opt.fullWidth) delete opt.fullWidth
  if (!opt.isCode) delete opt.isCode
  if (!opt.vector) delete opt.vector
  return opt
}

/**
 * Parses every `static t_config_enum_values s_keys_map_<Type> { ... }` table in
 * PrintConfig.cpp into a map of normalized C++ symbol -> serialized string, so
 * enum `set_default_value(...)` symbols can be turned into the string a preset
 * would store. Map values come in two forms: a bare symbol (`btAutoBrim`) or an
 * `int(Type::Member)` wrapper; both normalize to the trailing identifier.
 */
function parseEnumKeyMaps(content) {
  const maps = new Map()
  const re = /t_config_enum_values\s+s_keys_map_(\w+)\s*(?:=)?\s*\{([\s\S]*?)\}\s*;/g
  let m
  while ((m = re.exec(content)) !== null) {
    const type = m[1]
    const entryRe = /\{\s*"([^"]*)"\s*,\s*([^}]+?)\s*\}/g
    const map = new Map()
    let e
    while ((e = entryRe.exec(m[2])) !== null) {
      const norm = normalizeEnumSymbol(e[2])
      if (!map.has(norm)) map.set(norm, e[1])
    }
    maps.set(type, map)
  }
  return maps
}

/** Reduces an enum value/symbol to its trailing identifier for cross-form matching. */
function normalizeEnumSymbol(raw) {
  let s = raw.trim().replace(/^int\s*\(\s*/, '').replace(/\)\s*$/, '').trim()
  const idx = s.lastIndexOf('::')
  if (idx >= 0) s = s.slice(idx + 2)
  return s.trim()
}

/** Best-effort extraction of a serialized default value from set_default_value(...). */
function parseDefault(stmt, fieldType) {
  const inner = stmt.slice(stmt.indexOf('(') + 1)
  if (fieldType === 'bool') {
    if (/\b(true|1)\b/.test(inner)) return '1'
    if (/\b(false|0)\b/.test(inner)) return '0'
    return undefined
  }
  if (fieldType === 'enum') {
    return undefined // handled separately via enum key maps (see resolveEnumDefaults)
  }
  if (fieldType === 'string') {
    if (/ConfigOptionString[^(]*\(\s*"/.test(inner)) return extractString(inner)
    return undefined
  }
  if (fieldType === 'percent') {
    const n = parseNumber(inner)
    return n === undefined ? undefined : `${n}%`
  }
  const n = parseNumber(inner)
  return n === undefined ? undefined : String(n)
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

  // Index every option-definition block by key.
  const addRe = /def\s*=\s*this->add(?:_nullable)?\(\s*"([^"]+)"\s*,\s*(co\w+)/g
  const blocks = new Map()
  const matches = []
  let m
  while ((m = addRe.exec(content)) !== null) {
    matches.push({ key: m[1], coType: m[2], start: m.index })
  }

  // Map saved def variables (e.g. `auto def_top_fill_pattern = def = this->add("top_surface_pattern", ...)`)
  // to their option key so enum copy-assignments can be resolved.
  const varToKey = new Map()
  const varRe = /(?:auto\s+)?(\w+)\s*=\s*def\s*=\s*this->add\(\s*"([^"]+)"/g
  let vm
  while ((vm = varRe.exec(content)) !== null) {
    if (vm[1] !== 'def') varToKey.set(vm[1], vm[2])
  }
  for (let i = 0; i < matches.length; i++) {
    const next = matches[i + 1]?.start ?? content.length
    const block = content.slice(matches[i].start, next)
    blocks.set(matches[i].key, { coType: matches[i].coType, block })
  }

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
          const parsed = parseBlock(entry.coType, entry.block)
          // Apply layout-level overrides for special lines.
          options[key] = parsed
        }
      }
    }
  }

  // Resolve enum copy-assignments (e.g. bottom_surface_pattern inherits top_surface_pattern enums).
  for (const [, opt] of Object.entries(options)) {
    if (opt.enumRefVar) {
      const sourceKey = varToKey.get(opt.enumRefVar)
      const source = sourceKey ? options[sourceKey] : undefined
      if (source && source.enumValues) {
        opt.enumValues = [...source.enumValues]
        opt.enumLabels = [...(source.enumLabels ?? [])]
      }
      delete opt.enumRefVar
    }
  }

  // Resolve enum defaults (e.g. ironing_pattern -> "zig-zag") from the
  // s_keys_map_<Type> tables. The preset inheritance chain leaves many enum
  // options unset, so without this they would render blank in the editor even
  // though BambuStudio shows the PrintConfig default.
  const enumMaps = parseEnumKeyMaps(content)
  for (const [, opt] of Object.entries(options)) {
    if (opt.enumDefaultSymbol) {
      const map = enumMaps.get(opt.enumDefaultType)
      const str = map?.get(normalizeEnumSymbol(opt.enumDefaultSymbol))
      if (str !== undefined) opt.default = str
      delete opt.enumDefaultType
      delete opt.enumDefaultSymbol
    }
  }

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
