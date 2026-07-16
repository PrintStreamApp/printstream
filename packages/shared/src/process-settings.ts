/**
 * Bambu-faithful process (quality) settings contracts and logic.
 *
 * This module owns the typed catalog (generated from BambuStudio's
 * `PrintConfig.cpp` + `TabPrint::build()`), the value accessor, the conditional
 * show/enable engine (a faithful translation of
 * `ConfigManipulation::toggle_print_fff_options`), and the value-coercion
 * validation (a translation of the deterministic clamps in
 * `ConfigManipulation::update_print_fff_config`). The web editor renders the
 * catalog; the API persists/merges the resulting overrides.
 *
 * Config values use BambuStudio's serialized form: scalars are strings
 * ("0.2", "20%", enum keys, "1"/"0" booleans) and vector options are arrays
 * of those strings. Overrides carry only the keys the user changed.
 */
import { z } from 'zod'
import { processSettingsCatalog } from './generated/process-settings.generated.js'

export type ProcessSettingType =
  | 'bool'
  | 'int'
  | 'float'
  | 'percent'
  | 'floatOrPercent'
  | 'enum'
  | 'string'
  | 'point'

export type ProcessSettingMode = 'simple' | 'advanced' | 'develop'

export interface ProcessSettingOption {
  type: ProcessSettingType
  label: string
  tooltip: string
  mode: ProcessSettingMode
  vector?: boolean
  sidetext?: string
  category?: string
  enumValues?: string[]
  enumLabels?: string[]
  min?: number
  max?: number
  default?: string
  guiType?: string
  fullWidth?: boolean
  isCode?: boolean
  height?: number
}

export interface ProcessSettingLine {
  label?: string
  keys: string[]
  fullWidth?: boolean
  code?: boolean
  height?: number
}

export interface ProcessSettingGroup {
  title: string
  lines: ProcessSettingLine[]
}

export interface ProcessSettingPage {
  id: string
  title: string
  groups: ProcessSettingGroup[]
}

export interface ProcessSettingsCatalog {
  pages: ProcessSettingPage[]
  options: Record<string, ProcessSettingOption>
}

export { processSettingsCatalog }

/**
 * Every recognized process-setting key (the catalog's options). Use this as an ALLOWLIST when
 * reading per-object/per-part overrides out of a 3MF's `model_settings.config`: a `<part>`/`<object>`
 * carries process settings (e.g. `sparse_infill_density`) intermixed with identity/placement metadata
 * (`name`, `extruder`, `source_object_id`, `source_offset_x`, `matrix`, …). Treating "everything that
 * isn't a known structural key" as a process override wrongly pulls that placement metadata in. Only
 * keys in this set are process overrides.
 */
export const PROCESS_SETTING_KEYS: ReadonlySet<string> = new Set(Object.keys(processSettingsCatalog.options))

/** True when `key` is a recognized process setting (vs. identity/placement part metadata). */
export function isProcessSettingKey(key: string): boolean {
  return PROCESS_SETTING_KEYS.has(key)
}

/** A serialized config value: a scalar string, or a vector of scalar strings. */
export type ProcessConfigValue = string | string[]
export type ProcessConfig = Record<string, ProcessConfigValue>

/** Sparse map of changed keys carried with a slice request or saved preset. */
export const processSettingOverridesSchema = z.record(
  z.string().min(1),
  z.union([z.string(), z.array(z.string())])
)
export type ProcessSettingOverrides = z.infer<typeof processSettingOverridesSchema>

/**
 * Curated subset of process settings that may be overridden per object (Bambu Studio exposes a
 * subset, not the full process config, in its per-object panel). Editors restrict the per-object
 * catalog to these keys.
 */
export const PER_OBJECT_PROCESS_KEYS: readonly string[] = [
  'layer_height',
  'wall_loops', 'wall_generator', 'wall_distribution_count',
  'top_shell_layers', 'top_surface_pattern', 'bottom_shell_layers',
  'sparse_infill_density', 'sparse_infill_pattern', 'infill_direction',
  'enable_support', 'support_type', 'support_style', 'support_threshold_angle', 'support_on_build_plate_only',
  'brim_type', 'brim_width',
  'seam_position',
  'ironing_type', 'ironing_flow', 'ironing_spacing'
]

/** Request body for resolving a process profile's base config for the editor. */
export const resolveProcessConfigRequestSchema = z.object({
  processProfileId: z.string().trim().min(1),
  targetId: z.string().trim().min(1).nullable().optional(),
  /**
   * Library file id of the source 3MF. Required when `processProfileId` is a
   * project-embedded (`project:`) profile, whose base config lives in the
   * project's `Metadata/project_settings.config` rather than an installed preset.
   */
  sourceFileId: z.string().trim().min(1).nullable().optional()
})
export type ResolveProcessConfigRequest = z.infer<typeof resolveProcessConfigRequestSchema>

/**
 * Response for `/profiles/resolve-process`. Carries two baselines so the editor can show
 * settings baked into a 3MF as modified/resettable:
 * - `config`: the profile's **effective** config (for a project 3MF this is its embedded,
 *   already-overridden config — the base the slicer merges further overrides onto).
 * - `baseConfig`: the **preset baseline** to reset toward. Equal to `config` for installed
 *   presets; for a project 3MF it is the resolved system preset (when resolvable).
 * - `overriddenKeys`: process keys the 3MF marks as changed from system
 *   (`different_settings_to_system`), used as an authoritative "modified" signal even when the
 *   baseline preset can't be resolved.
 */
export interface ResolveProcessConfigResponse {
  config: ProcessConfig
  baseConfig: ProcessConfig
  overriddenKeys: string[]
}

/** Machine-derived context that affects conditional visibility. */
export interface ProcessVisibilityContext {
  /** Bambu Lab vendor printer: hides manual jerk fields (firmware manages jerk). */
  isBBL: boolean
  /** Klipper flavor unlocks accel-to-decel and per-object exclusion. */
  gcodeFlavor: string
  /** Printer model id; gates prime-tower interface features (H2C/H2D/X2D). */
  printerModel: string
  /** Whether the selected printer supports nozzle wrapping detection. */
  supportsWrappingDetection: boolean
  /** True for the global process preset (vs a per-object override). */
  isGlobalConfig: boolean
}

export const defaultProcessVisibilityContext: ProcessVisibilityContext = {
  isBBL: true,
  gcodeFlavor: 'marlin',
  printerModel: '',
  supportsWrappingDetection: false,
  isGlobalConfig: true
}

const EPSILON = 1e-4

/** Authoritative InfillPattern serialized keys (PrintConfig.cpp s_keys_map_InfillPattern). */
const INFILL = {
  rectilinear: 'zig-zag',
  stars: 'tri-hexagon',
  cubic: 'cubic',
  grid: 'grid',
  alignedRectilinear: 'alignedrectilinear',
  gyroid: 'gyroid',
  honeycomb: 'honeycomb',
  lightning: 'lightning',
  threeDHoneycomb: '3dhoneycomb',
  adaptiveCubic: 'adaptivecubic',
  supportCubic: 'supportcubic',
  zigzag: 'zigzag',
  crossZag: 'crosszag',
  lockedZag: 'lockedzag',
  lattice2d: '2dlattice'
} as const

const SUPPORT_MULTILINE_PATTERNS = new Set<string>([
  INFILL.cubic, INFILL.grid, INFILL.rectilinear, INFILL.stars, INFILL.alignedRectilinear,
  INFILL.gyroid, INFILL.honeycomb, INFILL.lightning, INFILL.threeDHoneycomb,
  INFILL.adaptiveCubic, INFILL.supportCubic
])

/** support_style enum keys grouped by support family (PrintConfig.cpp + toggle_options). */
const SUPPORT_STYLE_NORMAL = ['default', 'grid', 'snug']
const SUPPORT_STYLE_TREE = ['default', 'tree_slim', 'tree_strong', 'tree_hybrid', 'tree_organic']

function firstScalar(value: ProcessConfigValue | undefined): string {
  if (value === undefined) return ''
  return Array.isArray(value) ? (value[0] ?? '') : value
}

/** Typed accessor over a serialized process config. */
export interface ProcessConfigAccessor {
  has: (key: string) => boolean
  str: (key: string) => string
  num: (key: string) => number
  int: (key: string) => number
  bool: (key: string) => boolean
  percent: (key: string) => number
  isPercent: (key: string) => boolean
  enum: (key: string) => string
}

export function createProcessConfigAccessor(config: ProcessConfig): ProcessConfigAccessor {
  const raw = (key: string) => firstScalar(config[key])
  return {
    has: (key) => config[key] !== undefined,
    str: (key) => raw(key),
    num: (key) => {
      const n = Number.parseFloat(raw(key))
      return Number.isFinite(n) ? n : 0
    },
    int: (key) => {
      const n = Number.parseInt(raw(key), 10)
      return Number.isFinite(n) ? n : 0
    },
    bool: (key) => {
      const v = raw(key).toLowerCase()
      return v === '1' || v === 'true'
    },
    percent: (key) => {
      const n = Number.parseFloat(raw(key).replace('%', ''))
      return Number.isFinite(n) ? n : 0
    },
    isPercent: (key) => raw(key).includes('%'),
    enum: (key) => raw(key)
  }
}

/**
 * Overlays the resolved preset config on top of every catalog option's
 * PrintConfig default, returning the full effective config BambuStudio would
 * display. Preset values always win; only keys the preset leaves unset are
 * filled from `option.default`. This mirrors BambuStudio's model where a preset
 * stores only its overrides and the rest come from `FullPrintConfig` defaults,
 * so the editor shows real values instead of blanks for un-inherited keys.
 */
export function applyProcessConfigDefaults(config: ProcessConfig): ProcessConfig {
  const result: ProcessConfig = { ...config }
  for (const [key, option] of Object.entries(processSettingsCatalog.options)) {
    if (result[key] !== undefined) continue
    if (option.default !== undefined) result[key] = option.default
  }
  return result
}

/** Per-key field state derived from the conditional engine. */
export interface ProcessFieldState {
  /** Whether the line is rendered at all (BambuStudio toggle_line). */
  visible: boolean
  /** Whether the field accepts input (BambuStudio toggle_field). */
  enabled: boolean
}

export interface ProcessFieldStates {
  states: Map<string, ProcessFieldState>
  /** Keys whose enum option set is dynamically restricted (e.g. support_style). */
  enumRestrictions: Map<string, string[]>
}

function isTreeSupport(supportType: string): boolean {
  return supportType.includes('tree')
}

function isAutoSupport(supportType: string): boolean {
  return supportType.includes('auto')
}

/**
 * Faithful translation of ConfigManipulation::toggle_print_fff_options.
 * Returns, for every key it touches, whether its line is visible and whether
 * the field is enabled. Keys not touched default to visible + enabled.
 */
export function computeProcessFieldStates(
  config: ProcessConfig,
  context: ProcessVisibilityContext = defaultProcessVisibilityContext
): ProcessFieldStates {
  const c = createProcessConfigAccessor(config)
  const states = new Map<string, ProcessFieldState>()
  const enumRestrictions = new Map<string, string[]>()

  const get = (key: string): ProcessFieldState => {
    let s = states.get(key)
    if (!s) {
      s = { visible: true, enabled: true }
      states.set(key, s)
    }
    return s
  }
  const setLine = (key: string, visible: boolean) => { get(key).visible = visible }
  const setField = (key: string, enabled: boolean) => { get(key).enabled = enabled }

  const havePerimeters = c.int('wall_loops') > 0
  for (const el of ['ensure_vertical_shell_thickness', 'detect_thin_wall', 'detect_overhang_wall',
    'seam_position', 'seam_placement_away_from_overhangs', 'seam_gap', 'wipe_speed', 'wall_sequence', 'outer_wall_line_width',
    'inner_wall_speed', 'outer_wall_speed', 'small_perimeter_speed', 'small_perimeter_threshold']) {
    setField(el, havePerimeters)
  }

  const seamPos = c.enum('seam_position')
  setLine('seam_placement_away_from_overhangs', seamPos === 'aligned' || seamPos === 'back')

  const haveInfill = c.percent('sparse_infill_density') > 0
  for (const el of ['sparse_infill_pattern', 'sparse_infill_anchor_max', 'infill_combination', 'minimum_sparse_infill_area', 'sparse_infill_filament', 'infill_shift_step',
    'infill_rotate_step', 'symmetric_infill_y_axis', 'sparse_infill_lattice_angle_1', 'sparse_infill_lattice_angle_2']) {
    setLine(el, haveInfill)
  }

  const pattern = c.enum('sparse_infill_pattern')
  const supportMultiline = SUPPORT_MULTILINE_PATTERNS.has(pattern)
  setLine('fill_multiline', haveInfill && supportMultiline)

  const hasInfillAnchors = haveInfill && c.num('sparse_infill_anchor_max') > 0
  setLine('sparse_infill_anchor', hasInfillAnchors)

  const isCrossZag = haveInfill && pattern === INFILL.crossZag
  const isLockedZig = haveInfill && pattern === INFILL.lockedZag
  for (const el of ['infill_instead_top_bottom_surfaces', 'skeleton_infill_density', 'skin_infill_density', 'infill_lock_depth', 'skin_infill_depth', 'skin_infill_line_width', 'skeleton_infill_line_width', 'locked_skin_infill_pattern', 'locked_skeleton_infill_pattern']) {
    setLine(el, isLockedZig)
  }

  const isZigZag = haveInfill && pattern === INFILL.zigzag
  setLine('infill_rotate_step', isZigZag)
  setLine('infill_shift_step', isCrossZag || isLockedZig)
  setLine('symmetric_infill_y_axis', isZigZag || isCrossZag || isLockedZig)

  const latticeOptions = haveInfill && pattern === INFILL.lattice2d
  for (const el of ['sparse_infill_lattice_angle_1', 'sparse_infill_lattice_angle_2']) setLine(el, latticeOptions)

  const hasSpiralVase = c.bool('spiral_mode')
  setLine('spiral_mode_smooth', hasSpiralVase)
  setLine('spiral_mode_max_xy_smoothing', c.bool('spiral_mode_smooth'))
  setField('z_direction_outwall_speed_continuous', !hasSpiralVase)

  const hasTopSolidInfill = c.int('top_shell_layers') > 0
  const hasBottomSolidInfill = c.int('bottom_shell_layers') > 0
  const hasSolidInfill = hasTopSolidInfill || hasBottomSolidInfill
  for (const el of ['top_surface_pattern', 'bottom_surface_pattern', 'top_surface_density', 'bottom_surface_density', 'internal_solid_infill_pattern', 'solid_infill_filament']) {
    setField(el, hasSolidInfill)
  }
  for (const el of ['infill_direction', 'sparse_infill_line_width', 'bridge_angle', 'sparse_infill_speed', 'bridge_speed']) {
    setField(el, haveInfill || hasSolidInfill)
  }
  setField('top_shell_thickness', !hasSpiralVase && hasTopSolidInfill)
  setField('bottom_shell_thickness', !hasSpiralVase && hasBottomSolidInfill)
  setField('gap_infill_speed', havePerimeters)
  for (const el of ['top_surface_line_width', 'top_surface_speed']) {
    setField(el, hasTopSolidInfill || (hasSpiralVase && hasBottomSolidInfill))
  }

  const haveDefaultAcceleration = c.num('default_acceleration') > 0
  for (const el of ['initial_layer_acceleration', 'outer_wall_acceleration', 'top_surface_acceleration', 'inner_wall_acceleration', 'sparse_infill_acceleration']) {
    setField(el, haveDefaultAcceleration)
  }

  const jerkKeys = ['default_jerk', 'outer_wall_jerk', 'inner_wall_jerk', 'infill_jerk', 'top_surface_jerk', 'initial_layer_jerk', 'travel_jerk']
  if (context.isBBL) {
    for (const el of jerkKeys) setLine(el, false)
  } else {
    for (const el of jerkKeys) setLine(el, true)
    const qualityDefaultJerk = c.num('default_jerk') > 0
    for (const el of ['outer_wall_jerk', 'inner_wall_jerk', 'infill_jerk', 'top_surface_jerk', 'initial_layer_jerk', 'travel_jerk']) {
      setField(el, qualityDefaultJerk)
    }
  }

  const haveSkirt = c.int('skirt_loops') > 0
  // draft_shield is not exposed in the process tab; treat as disabled (default).
  setField('skirt_height', haveSkirt)
  for (const el of ['skirt_distance']) setField(el, haveSkirt)

  const brimType = c.enum('brim_type')
  const haveBrim = brimType !== 'no_brim'
  setField('brim_object_gap', haveBrim)
  const haveBrimWidth = haveBrim && brimType !== 'auto_brim' && brimType !== 'brim_ears'
  setField('brim_width', haveBrimWidth)
  setField('wall_filament', havePerimeters || haveBrim)

  const haveRaft = c.int('raft_layers') > 0
  const haveSupportMaterial = c.bool('enable_support') || haveRaft
  const supportType = c.enum('support_type')
  const haveSupportInterface = c.int('support_interface_top_layers') > 0 || c.int('support_interface_bottom_layers') > 0
  const haveSupportSoluble = haveSupportMaterial && c.num('support_top_z_distance') === 0
  for (const el of ['support_style', 'support_base_pattern', 'support_base_pattern_spacing', 'support_expansion', 'support_angle',
    'support_interface_pattern', 'support_interface_top_layers', 'bridge_no_support', 'max_bridge_length', 'support_top_z_distance', 'support_bottom_z_distance',
    'support_type', 'support_on_build_plate_only', 'support_remove_small_overhang', 'support_interface_not_for_body',
    'support_object_xy_distance', 'support_object_first_layer_gap']) {
    setField(el, haveSupportMaterial)
  }
  setField('support_threshold_angle', haveSupportMaterial && isAutoSupport(supportType))

  const supportIsTree = c.bool('enable_support') && isTreeSupport(supportType)
  for (const el of ['tree_support_branch_angle', 'tree_support_branch_distance', 'tree_support_branch_diameter', 'tree_support_branch_diameter_angle']) {
    setField(el, supportIsTree)
  }
  for (const el of ['tree_support_branch_angle', 'tree_support_branch_distance', 'tree_support_branch_diameter', 'tree_support_branch_diameter_angle', 'max_bridge_length']) {
    setLine(el, supportIsTree)
  }
  setLine('support_critical_regions_only', isAutoSupport(supportType) && supportIsTree)

  const detectNarrow = c.bool('detect_narrow_internal_solid_infill')
  setLine('detect_floating_vertical_shell', detectNarrow)
  setLine('vertical_shell_speed', detectNarrow)

  setLine('bridge_no_support', !supportIsTree)
  setLine('support_bottom_interface_spacing', !supportIsTree)
  setLine('support_interface_bottom_layers', !supportIsTree)

  for (const el of ['support_interface_spacing', 'support_interface_filament']) {
    setField(el, haveSupportMaterial && haveSupportInterface)
  }

  const haveSkirtHeight = haveSkirt && c.int('skirt_height') > 1
  setLine('support_speed', haveSupportMaterial || haveSkirtHeight)
  setLine('support_interface_speed', haveSupportMaterial && haveSupportInterface)

  setField('inner_wall_line_width', havePerimeters || haveSkirt || haveBrim)
  setField('support_filament', haveSupportMaterial || haveSkirt)

  setLine('raft_contact_distance', haveRaft && !haveSupportSoluble)

  const hasIroning = c.enum('ironing_type') !== 'no ironing'
  for (const el of ['ironing_pattern', 'ironing_speed', 'ironing_flow', 'ironing_spacing', 'ironing_direction', 'ironing_inset']) {
    setLine(el, hasIroning)
  }

  const hasIroningSupport = c.int('raft_layers') > 1 || (c.bool('enable_support') && c.int('support_interface_top_layers') > 0)
  setField('enable_support_ironing', hasIroningSupport)
  for (const el of ['support_ironing_pattern', 'support_ironing_speed', 'support_ironing_flow', 'support_ironing_spacing', 'support_ironing_direction', 'support_ironing_inset']) {
    setLine(el, c.bool('enable_support_ironing') && hasIroningSupport)
  }

  const havePrimeTower = c.bool('enable_prime_tower')
  for (const el of ['prime_tower_width', 'prime_tower_brim_width', 'prime_tower_skip_points', 'prime_tower_rib_wall', 'prime_tower_infill_gap', 'prime_tower_enable_framework', 'prime_tower_max_speed']) {
    setLine(el, havePrimeTower)
  }
  const towerInterfaceSupported = /H2C|H2D|X2D/i.test(context.printerModel)
  setLine('enable_tower_interface_features', havePrimeTower && towerInterfaceSupported)
  const haveRibWall = c.bool('prime_tower_rib_wall') && havePrimeTower
  for (const el of ['prime_tower_extra_rib_length', 'prime_tower_rib_width', 'prime_tower_fillet_wall']) {
    setLine(el, haveRibWall)
  }
  setField('prime_tower_width', !haveRibWall)
  for (const el of ['flush_into_infill', 'flush_into_support', 'flush_into_objects']) {
    setField(el, havePrimeTower)
  }

  const haveAvoidCrossing = c.bool('reduce_crossing_wall')
  setLine('max_travel_detour_distance', haveAvoidCrossing)
  setLine('avoid_crossing_wall_includes_support', haveAvoidCrossing)

  const hasOverhangSpeed = c.bool('enable_overhang_speed')
  for (const el of ['overhang_1_4_speed', 'overhang_2_4_speed', 'overhang_3_4_speed', 'overhang_4_4_speed']) {
    setLine(el, hasOverhangSpeed)
  }

  const hasHeightSlowdown = c.bool('enable_height_slowdown')
  for (const el of ['slowdown_start_height', 'slowdown_start_speed', 'slowdown_start_acc', 'slowdown_end_height', 'slowdown_end_speed', 'slowdown_end_acc']) {
    setLine(el, hasHeightSlowdown)
  }

  setLine('flush_into_objects', !context.isGlobalConfig)
  setLine('print_flow_ratio', !context.isGlobalConfig)
  setLine('wall_filament', !context.isGlobalConfig)
  setLine('solid_infill_filament', !context.isGlobalConfig)
  setLine('sparse_infill_filament', !context.isGlobalConfig)

  setLine('support_interface_not_for_body', c.int('support_interface_filament') !== 0 && c.int('support_filament') === 0)

  const hasFuzzySkin = c.enum('fuzzy_skin') !== 'disabled_fuzzy'
  for (const el of ['fuzzy_skin_thickness', 'fuzzy_skin_point_distance', 'fuzzy_skin_first_layer', 'fuzzy_skin_noise_type', 'fuzzy_skin_mode']) {
    setLine(el, hasFuzzySkin)
  }
  const noiseType = c.enum('fuzzy_skin_noise_type')
  setLine('fuzzy_skin_scale', noiseType !== 'classic' && hasFuzzySkin)
  setLine('fuzzy_skin_octaves', noiseType !== 'classic' && noiseType !== 'voronoi' && hasFuzzySkin)
  setLine('fuzzy_skin_persistence', (noiseType === 'perlin' || noiseType === 'billow') && hasFuzzySkin)

  const haveArachne = c.enum('wall_generator') === 'arachne'
  for (const el of ['wall_transition_length', 'wall_transition_filter_deviation', 'wall_transition_angle', 'min_feature_size', 'min_bead_width', 'wall_distribution_count']) {
    setLine(el, haveArachne)
  }
  setField('detect_thin_wall', !haveArachne)

  const isKlipper = context.gcodeFlavor === 'klipper'
  if (!isKlipper) {
    for (const el of ['accel_to_decel_enable', 'accel_to_decel_factor']) setLine(el, false)
  } else {
    for (const el of ['accel_to_decel_enable', 'accel_to_decel_factor']) setLine(el, true)
    setField('accel_to_decel_factor', c.bool('accel_to_decel_enable'))
  }
  setLine('exclude_object', isKlipper)

  const useBeamInterlocking = c.bool('interlocking_beam')
  setLine('mmu_segmented_region_interlocking_depth', !useBeamInterlocking)
  for (const el of ['interlocking_beam_width', 'interlocking_orientation', 'interlocking_beam_layer_count', 'interlocking_depth', 'interlocking_boundary_avoidance']) {
    setLine(el, useBeamInterlocking)
  }

  const autoCircleComp = c.bool('enable_circle_compensation')
  setField('xy_hole_compensation', !autoCircleComp)
  setField('xy_contour_compensation', !autoCircleComp)
  setLine('circle_compensation_manual_offset', autoCircleComp)

  const overrideScarf = c.bool('override_filament_scarf_seam_setting')
  for (const el of ['seam_slope_type', 'seam_slope_start_height', 'seam_slope_gap', 'seam_slope_min_length']) {
    setLine(el, overrideScarf)
  }

  setLine('enable_wrapping_detection', context.supportsWrappingDetection)

  // top_area_threshold is gated by top_one_wall_type (update_print_fff_config).
  setLine('top_area_threshold', c.enum('top_one_wall_type') !== 'not apply')

  // Dynamic support_style option set based on support family (toggle_options tail).
  enumRestrictions.set('support_style', isTreeSupport(supportType) ? SUPPORT_STYLE_TREE : SUPPORT_STYLE_NORMAL)

  return { states, enumRestrictions }
}

export function getProcessFieldState(states: Map<string, ProcessFieldState>, key: string): ProcessFieldState {
  return states.get(key) ?? { visible: true, enabled: true }
}

/** A value correction Bambu applies after an out-of-range entry. */
export interface ProcessValidationIssue {
  key: string
  message: string
  /** Deterministic corrections to apply (key -> serialized value). */
  fix: ProcessConfig
}

/**
 * Faithful translation of the deterministic value clamps in
 * ConfigManipulation::update_print_fff_config (the OK-only "reset to X"
 * dialogs and unconditional coercions). Interactive yes/no flows are not
 * auto-applied here. Returns the issues triggered by the current config.
 */
export function validateProcessConfig(config: ProcessConfig): ProcessValidationIssue[] {
  const c = createProcessConfigAccessor(config)
  const issues: ProcessValidationIssue[] = []

  if (c.has('layer_height') && c.num('layer_height') < EPSILON) {
    issues.push({ key: 'layer_height', message: 'Too small layer height. Reset to 0.2', fix: { layer_height: '0.2' } })
  } else if (c.has('layer_height') && c.num('layer_height') > 0.6 + EPSILON) {
    issues.push({ key: 'layer_height', message: 'Too large layer height. Reset to 0.2', fix: { layer_height: '0.2' } })
  }

  if (c.has('seam_slope_start_height')) {
    const isPct = c.isPercent('seam_slope_start_height')
    const raw = c.percent('seam_slope_start_height')
    const reset = isPct ? raw >= 100 : raw >= c.num('layer_height')
    if (reset) {
      issues.push({ key: 'seam_slope_start_height', message: 'Should not be larger than layer height. Reset to 10%', fix: { seam_slope_start_height: '10%' } })
    }
  }

  if (c.has('ironing_spacing') && c.num('ironing_spacing') < 0.05) {
    issues.push({ key: 'ironing_spacing', message: 'Too small ironing spacing. Reset to 0.1', fix: { ironing_spacing: '0.1' } })
  }
  if (c.has('support_ironing_spacing') && c.num('support_ironing_spacing') < 0.05) {
    issues.push({ key: 'support_ironing_spacing', message: 'Too small support ironing spacing. Reset to 0.1', fix: { support_ironing_spacing: '0.1' } })
  }

  if (c.has('initial_layer_print_height') && c.num('initial_layer_print_height') < EPSILON) {
    issues.push({ key: 'initial_layer_print_height', message: 'Zero initial layer height is invalid. Reset to 0.2', fix: { initial_layer_print_height: '0.2' } })
  }

  if (c.has('xy_hole_compensation') && Math.abs(c.num('xy_hole_compensation')) > 2) {
    issues.push({ key: 'xy_hole_compensation', message: 'Value out of range; reset to 0', fix: { xy_hole_compensation: '0' } })
  }
  if (c.has('xy_contour_compensation') && Math.abs(c.num('xy_contour_compensation')) > 2) {
    issues.push({ key: 'xy_contour_compensation', message: 'Value out of range; reset to 0', fix: { xy_contour_compensation: '0' } })
  }
  if (c.bool('enable_circle_compensation')) {
    if (c.num('xy_hole_compensation') !== 0 || c.num('xy_contour_compensation') !== 0) {
      issues.push({ key: 'enable_circle_compensation', message: 'Auto circle compensation disables manual XY compensation', fix: { xy_hole_compensation: '0', xy_contour_compensation: '0' } })
    }
  }

  if (c.has('elefant_foot_compensation') && c.num('elefant_foot_compensation') > 1) {
    issues.push({ key: 'elefant_foot_compensation', message: 'Too large elephant foot compensation; reset to 0', fix: { elefant_foot_compensation: '0' } })
  }

  if (c.bool('interlocking_beam') && c.num('interlocking_beam_width') <= 0) {
    issues.push({ key: 'interlocking_beam_width', message: "Interlocking beam width can't be zero. Reset to 0.01 mm", fix: { interlocking_beam_width: '0.01' } })
  }

  if (c.has('infill_lock_depth') && c.has('skin_infill_depth') && c.num('infill_lock_depth') > c.num('skin_infill_depth')) {
    const half = c.num('skin_infill_depth') / 2
    issues.push({ key: 'infill_lock_depth', message: 'Lock depth should be smaller than skin depth. Reset to 50% of skin depth', fix: { infill_lock_depth: String(half) } })
  }

  if (c.enum('print_sequence') === 'by object' && c.int('skirt_height') > 1 && c.int('skirt_loops') > 0) {
    issues.push({ key: 'skirt_height', message: 'While printing by object, reset skirt layers to 1 to avoid collision', fix: { skirt_height: '1' } })
  }

  if (c.bool('enable_support')) {
    const validSet = isTreeSupport(c.enum('support_type')) ? SUPPORT_STYLE_TREE : SUPPORT_STYLE_NORMAL
    if (!validSet.includes(c.enum('support_style'))) {
      issues.push({ key: 'support_style', message: 'Support style is not valid for the selected support type; reset to Default', fix: { support_style: 'default' } })
    }
  }

  return issues
}

/** True if an option is visible in BambuStudio "Advanced" mode (everything except develop-only). */
export function isAdvancedModeOption(option: ProcessSettingOption): boolean {
  return option.mode !== 'develop'
}

/**
 * True if an option should be shown given whether developer-mode options are revealed.
 *
 * The editor normally hides BambuStudio's `develop`-tier options (see
 * {@link isAdvancedModeOption}); enabling developer mode reveals them too. This is the tier
 * gate only — a revealed option is still subject to the usual conditional
 * visibility/enable rules from {@link computeProcessFieldStates}.
 */
export function isProcessOptionVisibleInMode(option: ProcessSettingOption, showDeveloperOptions: boolean): boolean {
  return showDeveloperOptions || isAdvancedModeOption(option)
}

/**
 * Computes the sparse override map of keys whose value changed from the base.
 * Vector values are compared element-wise.
 */
export function diffProcessConfig(base: ProcessConfig, edited: ProcessConfig): ProcessSettingOverrides {
  const overrides: ProcessSettingOverrides = {}
  for (const [key, value] of Object.entries(edited)) {
    const baseValue = base[key]
    if (!processConfigValuesEqual(baseValue, value)) {
      overrides[key] = value
    }
  }
  return overrides
}

/**
 * Value-equality for process config entries. Scalars compare by string; vectors
 * compare element-wise. A scalar and a single-element vector with the same value
 * are treated as equal (BambuStudio serializes some scalars as 1-length vectors).
 */
export function processConfigValuesEqual(a: ProcessConfigValue | undefined, b: ProcessConfigValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  if (Array.isArray(a) || Array.isArray(b)) {
    const aa = Array.isArray(a) ? a : [a]
    const bb = Array.isArray(b) ? b : [b]
    if (aa.length !== bb.length) return false
    return aa.every((v, i) => v === bb[i])
  }
  return a === b
}

/** Serialize a boolean to BambuStudio's "1"/"0" form. */
export function serializeProcessBool(value: boolean): string {
  return value ? '1' : '0'
}
