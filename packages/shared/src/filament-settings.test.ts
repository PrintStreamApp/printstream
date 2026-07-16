import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyFilamentConfigDefaults,
  diffFilamentConfig,
  filamentConfigValuesEqual,
  filamentSettingOverridesSchema,
  filamentSettingsCatalog,
  FILAMENT_SETTING_KEYS,
  isFilamentSettingKey,
  resolveFilamentConfigRequestSchema,
  scalarizeFilamentConfig,
  type FilamentConfig
} from './filament-settings.js'

test('filament catalog has the Bambu tab pages and every line key resolves to an option', () => {
  const titles = filamentSettingsCatalog.pages.map((page) => page.title)
  assert.deepEqual(titles, ['Filament', 'Cooling', 'Setting Overrides', 'Advanced', 'Notes', 'Multi Filament'])
  for (const page of filamentSettingsCatalog.pages) {
    for (const group of page.groups) {
      for (const line of group.lines) {
        for (const key of line.keys) {
          assert.ok(filamentSettingsCatalog.options[key], `missing option metadata for ${key}`)
        }
      }
    }
  }
})

test('core material-physics options carry faithful metadata', () => {
  const nozzle = filamentSettingsCatalog.options.nozzle_temperature
  assert.equal(nozzle?.type, 'int')
  assert.equal(nozzle?.vector, true)
  assert.equal(nozzle?.sidetext, '°C')
  const chamber = filamentSettingsCatalog.options.chamber_temperatures
  assert.equal(chamber?.type, 'int')
  assert.equal(chamber?.max, 80)
  const flow = filamentSettingsCatalog.options.filament_flow_ratio
  assert.equal(flow?.type, 'float')
  assert.equal(flow?.default, '1')
})

test('Setting Overrides keys inherit their base option metadata + Bambu override mode', () => {
  // filament_retraction_length copies retraction_length's metadata and is shown in simple mode;
  // filament_overhang_1_4_speed copies overhang_1_4_speed and stays advanced.
  const retract = filamentSettingsCatalog.options.filament_retraction_length
  assert.equal(retract?.label, 'Length')
  assert.equal(retract?.sidetext, 'mm')
  assert.equal(retract?.mode, 'simple')
  const overhang = filamentSettingsCatalog.options.filament_overhang_1_4_speed
  assert.equal(overhang?.mode, 'advanced')
  assert.equal(overhang?.sidetext, 'mm/s')
})

test('enum options have matching value/label counts', () => {
  for (const [key, option] of Object.entries(filamentSettingsCatalog.options)) {
    if (option.type === 'enum' && option.enumValues && option.enumLabels) {
      assert.equal(option.enumValues.length, option.enumLabels.length, `enum parity mismatch for ${key}`)
    }
  }
})

test('FILAMENT_SETTING_KEYS gates recognized keys', () => {
  assert.equal(isFilamentSettingKey('nozzle_temperature'), true)
  assert.equal(isFilamentSettingKey('filament_flow_ratio'), true)
  assert.equal(isFilamentSettingKey('sparse_infill_density'), false) // a process key, not filament
  assert.equal(FILAMENT_SETTING_KEYS.size, Object.keys(filamentSettingsCatalog.options).length)
})

test('applyFilamentConfigDefaults fills only un-inherited keys; preset values win', () => {
  const config: FilamentConfig = { nozzle_temperature: ['255'] }
  const full = applyFilamentConfigDefaults(config)
  assert.deepEqual(full.nozzle_temperature, ['255']) // preset value preserved
  assert.equal(full.filament_flow_ratio, '1') // filled from catalog default
})

test('diffFilamentConfig emits only changed keys; equality treats scalar == 1-vector', () => {
  const base: FilamentConfig = { nozzle_temperature: ['220'], filament_flow_ratio: '1' }
  const edited: FilamentConfig = { nozzle_temperature: ['240'], filament_flow_ratio: '1' }
  assert.deepEqual(diffFilamentConfig(base, edited), { nozzle_temperature: ['240'] })
  assert.equal(filamentConfigValuesEqual('220', ['220']), true)
})

test('scalarizeFilamentConfig collapses per-variant vectors to element 0 so a multi-variant baseline does not read as modified', () => {
  // Regression: a preset resolved for a 2-extruder-variant machine returns ["0","0"]/["10","10"]
  // while a project's per-slot config is a scalar. Length-sensitive equality flagged every such key
  // as modified and reset changed nothing visible. Collapsing both to element 0 fixes it.
  const baseline = scalarizeFilamentConfig({ nozzle_temperature: ['270', '270'], retraction_distances_when_ec: ['0', '0'] })
  const project: FilamentConfig = { nozzle_temperature: '270', retraction_distances_when_ec: '10' }
  assert.deepEqual(baseline, { nozzle_temperature: '270', retraction_distances_when_ec: '0' })
  // The identical value (nozzle temp) is no longer a phantom diff; only the genuine change remains.
  assert.deepEqual(diffFilamentConfig(baseline, scalarizeFilamentConfig(project)), { retraction_distances_when_ec: '10' })
})

test('prepareResolvedFilamentState + resolvedFilamentModifiedKeys: drift shows, blanks do not, heal overrides zero it', async () => {
  const { prepareResolvedFilamentState, resolvedFilamentModifiedKeys } = await import('./filament-settings.js')
  const state = prepareResolvedFilamentState({
    // Embedded project slot: ABS residue (270) under a PETG parent (255), plus a key the parent
    // doesn't define (blank default_filament_colour).
    config: { nozzle_temperature: '270', default_filament_colour: '', filament_flow_ratio: '0.95' },
    baseConfig: { nozzle_temperature: ['255', '255'], filament_flow_ratio: ['0.95', '0.95'] },
    overriddenKeys: []
  })
  // Drift flags; the parentless blank and the matching flow ratio do not.
  assert.deepEqual(resolvedFilamentModifiedKeys(state).sort(), ['nozzle_temperature'])
  // Session override moving the value further stays flagged…
  assert.deepEqual(resolvedFilamentModifiedKeys(state, { nozzle_temperature: '280' }), ['nozzle_temperature'])
  // …but a heal override back to the preset value reads clean (Reset all -> 0 badge).
  assert.deepEqual(resolvedFilamentModifiedKeys(state, { nozzle_temperature: ['255', '255'] }), [])
  // Shapes prefer the baseline's per-variant vector length.
  assert.equal(state.shapes.nozzle_temperature, 2)
})

test('resolvedFilamentModifiedKeys falls back to the 3MF record when the parent is unresolved', async () => {
  const { prepareResolvedFilamentState, resolvedFilamentModifiedKeys } = await import('./filament-settings.js')
  // Parent not installed: baseConfig === config, so value-diff finds nothing; the record flags.
  const state = prepareResolvedFilamentState({
    config: { nozzle_temperature: '270' },
    baseConfig: { nozzle_temperature: '270' },
    overriddenKeys: ['nozzle_temperature']
  })
  assert.deepEqual(resolvedFilamentModifiedKeys(state), ['nozzle_temperature'])
  // A session edit replaces the record flag with a value flag (still exactly one key).
  assert.deepEqual(resolvedFilamentModifiedKeys(state, { nozzle_temperature: '280' }), ['nozzle_temperature'])
})

test('override + resolve schemas validate their shapes', () => {
  assert.deepEqual(filamentSettingOverridesSchema.parse({ nozzle_temperature: ['240'] }), { nozzle_temperature: ['240'] })
  const req = resolveFilamentConfigRequestSchema.parse({ filamentProfileId: 'builtin:filament:x', projectFilamentId: 2 })
  assert.equal(req.projectFilamentId, 2)
})
