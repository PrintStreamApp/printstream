import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FILAMENT_INDEX_PROCESS_KEYS,
  applyProcessConfigDefaults,
  computeProcessFieldStates,
  defaultProcessVisibilityContext,
  diffProcessConfig,
  getProcessFieldState,
  isProcessOptionVisibleInMode,
  processConfigValuesEqual,
  processSettingsCatalog,
  processSettingOverridesSchema,
  validateProcessConfig,
  type ProcessConfig
} from './process-settings.js'

test('catalog has pages and every line key resolves to an option', () => {
  assert.ok(processSettingsCatalog.pages.length >= 5)
  for (const page of processSettingsCatalog.pages) {
    for (const group of page.groups) {
      for (const line of group.lines) {
        for (const key of line.keys) {
          assert.ok(processSettingsCatalog.options[key], `missing option metadata for ${key}`)
        }
      }
    }
  }
})

test('enum options have matching value/label counts', () => {
  for (const [key, option] of Object.entries(processSettingsCatalog.options)) {
    if (option.type === 'enum' && option.enumValues && option.enumLabels) {
      assert.equal(option.enumValues.length, option.enumLabels.length, `enum parity mismatch for ${key}`)
    }
  }
})

test('enum options carry a default resolved from the BambuStudio key maps', () => {
  // Regression: enum defaults (e.g. ironing_pattern, brim_type) were dropped by
  // the generator, leaving them blank in the editor. They must now be present
  // and be a valid enum value for the option.
  const cases: Record<string, string> = {
    ironing_pattern: 'zig-zag',
    brim_type: 'auto_brim',
    wall_sequence: 'inner wall/outer wall',
    ensure_vertical_shell_thickness: 'enabled',
    slicing_mode: 'regular',
    timelapse_type: '0'
  }
  for (const [key, expected] of Object.entries(cases)) {
    const option = processSettingsCatalog.options[key]
    assert.ok(option, `missing option ${key}`)
    assert.equal(option.default, expected, `unexpected default for ${key}`)
    assert.ok(option.enumValues?.includes(expected), `default not in enumValues for ${key}`)
  }
})

test('applyProcessConfigDefaults fills unset keys without overriding preset values', () => {
  const resolved: ProcessConfig = { layer_height: '0.2', brim_type: 'no_brim' }
  const full = applyProcessConfigDefaults(resolved)
  // Preset values win.
  assert.equal(full.layer_height, '0.2')
  assert.equal(full.brim_type, 'no_brim')
  // Unset keys are filled from the catalog defaults.
  assert.equal(full.ironing_pattern, 'zig-zag')
  assert.equal(full.slice_closing_radius, '0.049')
  assert.equal(full.ensure_vertical_shell_thickness, 'enabled')
  // Original object is not mutated.
  assert.equal(resolved.ironing_pattern, undefined)
})

test('infill detail fields hidden when sparse_infill_density is zero', () => {
  const off: ProcessConfig = { sparse_infill_density: '0%', sparse_infill_pattern: 'grid' }
  const on: ProcessConfig = { sparse_infill_density: '20%', sparse_infill_pattern: 'grid' }
  const offStates = computeProcessFieldStates(off)
  const onStates = computeProcessFieldStates(on)
  assert.equal(getProcessFieldState(offStates.states, 'sparse_infill_pattern').visible, false)
  assert.equal(getProcessFieldState(onStates.states, 'sparse_infill_pattern').visible, true)
})

test('fill_multiline visible only for supported infill patterns', () => {
  const grid = computeProcessFieldStates({ sparse_infill_density: '20%', sparse_infill_pattern: 'grid' })
  const concentric = computeProcessFieldStates({ sparse_infill_density: '20%', sparse_infill_pattern: 'concentric' })
  assert.equal(getProcessFieldState(grid.states, 'fill_multiline').visible, true)
  assert.equal(getProcessFieldState(concentric.states, 'fill_multiline').visible, false)
})

test('wall fields disabled when no walls', () => {
  const noWalls = computeProcessFieldStates({ wall_loops: '0' })
  const walls = computeProcessFieldStates({ wall_loops: '2' })
  assert.equal(getProcessFieldState(noWalls.states, 'seam_position').enabled, false)
  assert.equal(getProcessFieldState(walls.states, 'seam_position').enabled, true)
})

test('jerk lines hidden for Bambu Lab printers and shown otherwise', () => {
  const bbl = computeProcessFieldStates({}, { ...defaultProcessVisibilityContext, isBBL: true })
  const generic = computeProcessFieldStates({}, { ...defaultProcessVisibilityContext, isBBL: false })
  assert.equal(getProcessFieldState(bbl.states, 'default_jerk').visible, false)
  assert.equal(getProcessFieldState(generic.states, 'default_jerk').visible, true)
})

test('support_style enum restricted by support family', () => {
  const normal = computeProcessFieldStates({ enable_support: '1', support_type: 'normal(auto)' })
  const tree = computeProcessFieldStates({ enable_support: '1', support_type: 'tree(auto)' })
  assert.deepEqual(normal.enumRestrictions.get('support_style'), ['default', 'grid', 'snug'])
  assert.deepEqual(tree.enumRestrictions.get('support_style'), ['default', 'tree_slim', 'tree_strong', 'tree_hybrid', 'tree_organic'])
})

test('arachne-only wall transition lines gated by wall_generator', () => {
  const classic = computeProcessFieldStates({ wall_generator: 'classic' })
  const arachne = computeProcessFieldStates({ wall_generator: 'arachne' })
  assert.equal(getProcessFieldState(classic.states, 'wall_transition_length').visible, false)
  assert.equal(getProcessFieldState(arachne.states, 'wall_transition_length').visible, true)
})

test('validation clamps out-of-range layer height to 0.2', () => {
  assert.deepEqual(validateProcessConfig({ layer_height: '0' }).map((issue) => issue.fix), [{ layer_height: '0.2' }])
  assert.deepEqual(validateProcessConfig({ layer_height: '0.8' }).map((issue) => issue.fix), [{ layer_height: '0.2' }])
  assert.equal(validateProcessConfig({ layer_height: '0.2' }).length, 0)
})

test('validation resets invalid support style for support family', () => {
  const issues = validateProcessConfig({ enable_support: '1', support_type: 'normal(auto)', support_style: 'tree_organic' })
  assert.equal(issues.length, 1)
  assert.deepEqual(issues[0]?.fix, { support_style: 'default' })
})

test('validation resets skirt height when printing by object', () => {
  const issues = validateProcessConfig({ print_sequence: 'by object', skirt_height: '3', skirt_loops: '1' })
  assert.deepEqual(issues.map((issue) => issue.fix), [{ skirt_height: '1' }])
})

test('diffProcessConfig returns only changed keys including vectors', () => {
  const base: ProcessConfig = { layer_height: '0.2', wall_loops: '2', line_width: ['0.4', '0.4'] }
  const edited: ProcessConfig = { layer_height: '0.3', wall_loops: '2', line_width: ['0.45', '0.4'] }
  assert.deepEqual(diffProcessConfig(base, edited), { layer_height: '0.3', line_width: ['0.45', '0.4'] })
})

test('value equality is option-aware: serialized form does not make a change', () => {
  const percent = processSettingsCatalog.options.monotonic_travel_into_wall
  const floatOrPercent = processSettingsCatalog.options.sparse_infill_anchor
  const float = processSettingsCatalog.options.layer_height
  const enumOption = processSettingsCatalog.options.sparse_infill_pattern

  // A preset JSON writes "45.0"; the same setting in a 3MF's project config is "45%". BambuStudio
  // ignores the suffix on a percent option, so both are 45% and neither is a user change.
  assert.equal(processConfigValuesEqual('45.0', '45%', percent), true)
  assert.equal(processConfigValuesEqual('45', '45.0', percent), true)
  assert.equal(processConfigValuesEqual('45%', '50%', percent), false)
  // floatOrPercent keeps the suffix meaningful: 400 mm is not 400% of the line width.
  assert.equal(processConfigValuesEqual('400', '400%', floatOrPercent), false)
  assert.equal(processConfigValuesEqual('400%', '400.0%', floatOrPercent), true)
  assert.equal(processConfigValuesEqual('0.2', '0.20', float), true)
  // Non-numeric types stay exact — and an unparseable numeric value never compares equal.
  assert.equal(processConfigValuesEqual('grid', 'Grid', enumOption), false)
  assert.equal(processConfigValuesEqual('nil', 'nan', float), false)
  // Without option metadata the comparison degrades to raw strings.
  assert.equal(processConfigValuesEqual('45.0', '45%'), false)
  // Vectors compare element-wise under the same rule.
  assert.equal(processConfigValuesEqual(['45.0', '45%'], ['45%', '45'], percent), true)
})

test('an absent value equals an empty one, so a blank never reads as changed', () => {
  // Builtin process presets never mention post_process, but BambuStudio's project config always
  // serializes the full option set and writes `"post_process": []`.
  const strings = processSettingsCatalog.options.post_process
  const text = processSettingsCatalog.options.process_notes
  assert.equal(processConfigValuesEqual(undefined, [], strings), true)
  assert.equal(processConfigValuesEqual(undefined, '', text), true)
  assert.equal(processConfigValuesEqual([''], [], strings), true)
  // A real value on either side is still a change.
  assert.equal(processConfigValuesEqual(undefined, ['/tmp/fix.py'], strings), false)
  assert.equal(processConfigValuesEqual(['/tmp/fix.py'], [], strings), false)
  assert.deepEqual(diffProcessConfig({ wall_loops: '2' }, { post_process: [], wall_loops: '2' }), {})
})

test('catalog defaults keep the percent flag on floatOrPercent options', () => {
  // BambuStudio's `ConfigOptionFloatOrPercent(400, true)` means 400% of the line width; emitting a
  // bare "400" made the dialog's reset target 400 mm.
  assert.equal(processSettingsCatalog.options.sparse_infill_anchor?.default, '400%')
  assert.equal(processSettingsCatalog.options.spiral_mode_max_xy_smoothing?.default, '200%')
})

test('diffProcessConfig ignores a percent value that only differs in serialized form', () => {
  const base: ProcessConfig = { monotonic_travel_into_wall: '45.0', wall_loops: '2' }
  const edited: ProcessConfig = { monotonic_travel_into_wall: '45%', wall_loops: '3' }
  assert.deepEqual(diffProcessConfig(base, edited), { wall_loops: '3' })
})

test('override schema accepts scalars and string vectors only', () => {
  assert.ok(processSettingOverridesSchema.safeParse({ layer_height: '0.2', line_width: ['0.4'] }).success)
  assert.equal(processSettingOverridesSchema.safeParse({ layer_height: 0.2 }).success, false)
})

test('developer-mode gate hides develop-tier options unless developer mode is on', () => {
  const options = Object.values(processSettingsCatalog.options)
  const developOption = options.find((option) => option.mode === 'develop')
  const advancedOption = options.find((option) => option.mode !== 'develop')
  assert.ok(developOption, 'catalog should carry at least one develop-tier option')
  assert.ok(advancedOption, 'catalog should carry non-develop options')

  // Develop-tier options are hidden by default, revealed only under developer mode.
  assert.equal(isProcessOptionVisibleInMode(developOption!, false), false)
  assert.equal(isProcessOptionVisibleInMode(developOption!, true), true)
  // Non-develop options are always visible regardless of the flag.
  assert.equal(isProcessOptionVisibleInMode(advancedOption!, false), true)
  assert.equal(isProcessOptionVisibleInMode(advancedOption!, true), true)
})

test('resolvedProcessModifiedKeys counts final-vs-baseline diffs, healed by overrides', async () => {
  const { resolvedProcessModifiedKeys } = await import('./process-settings.js')
  const response = {
    config: { layer_height: '0.28', wall_loops: '2' },
    baseConfig: { layer_height: '0.2', wall_loops: '2' },
    overriddenKeys: []
  }
  assert.deepEqual(resolvedProcessModifiedKeys(response), ['layer_height'])
  // A session override back to the baseline value heals the badge to zero.
  assert.deepEqual(resolvedProcessModifiedKeys(response, { layer_height: '0.2' }), [])
  // The 3MF record stands in when the baseline could not resolve (baseConfig === config).
  assert.deepEqual(
    resolvedProcessModifiedKeys({ config: { layer_height: '0.28' }, baseConfig: { layer_height: '0.28' }, overriddenKeys: ['layer_height'] }),
    ['layer_height']
  )
})

// Regression: the material picker used to key off the catalogue's `i_enum_open` gui type.
// BambuStudio shares that widget with numeric settings that ship preset choices, so
// "Top interface layers" (a LAYER COUNT defaulting to 3) rendered as a material select and
// showed material 3. The filament-index list must stay exactly the settings whose value IS a
// filament index — and every one of them must be an int with no enum choices of its own.
test('the filament-index process keys are filament indices, not numeric settings sharing the widget', async () => {
  const { processSettingsCatalog } = await import('./generated/process-settings.generated.js')
  const catalog = processSettingsCatalog.options as unknown as Record<string, { type: string; enumValues?: string[]; guiType?: string }>

  for (const key of FILAMENT_INDEX_PROCESS_KEYS) {
    const option = catalog[key]
    assert.ok(option, `${key} is missing from the catalog`)
    assert.equal(option.type, 'int', `${key} must be an int filament index`)
    assert.ok(!option.enumValues?.length, `${key} carries enum choices, so it is a numeric setting, not a filament index`)
  }

  // Layer counts share `i_enum_open` but must never be treated as materials.
  for (const key of ['support_interface_top_layers', 'support_interface_bottom_layers']) {
    assert.ok(!FILAMENT_INDEX_PROCESS_KEYS.includes(key), `${key} is a layer count, not a filament index`)
  }
})
