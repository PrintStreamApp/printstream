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

test('filament value equality is option-aware, so a percent written two ways is not a change', () => {
  // Same class as the process dialog: a preset serializes shrinkage as "100" while the project's
  // embedded config carries "100%". Both are 100% to BambuStudio.
  const shrink = filamentSettingsCatalog.options.filament_shrink
  assert.equal(filamentConfigValuesEqual(['100'], ['100%'], shrink), true)
  assert.equal(filamentConfigValuesEqual(['100%'], ['98%'], shrink), false)
  assert.deepEqual(diffFilamentConfig({ filament_shrink: ['100'] }, { filament_shrink: ['100%'] }), {})
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

// Regression (2026-07-19, reported on the H2D "Kawasaki" project): a support material read as
// permanently "changed vs preset" the moment the project was reopened. Its embedded config held
// only identity keys — filament_type PLA-S against Bambu's "Support For PLA/PETG" preset, which
// declares itself PLA — so the badge counted a difference the user never made.
test('identity keys never count as a filament settings change', async () => {
  const { prepareResolvedFilamentState, resolvedFilamentModifiedKeys } = await import('./filament-settings.js')
  const state = prepareResolvedFilamentState({
    config: { filament_type: 'PLA-S', filament_notes: '' },
    baseConfig: { filament_type: ['PLA'] },
    overriddenKeys: []
  } as never)
  assert.deepEqual(resolvedFilamentModifiedKeys(state), [])
})

test('a real tuning difference still counts alongside identity keys', async () => {
  const { prepareResolvedFilamentState, resolvedFilamentModifiedKeys } = await import('./filament-settings.js')
  const state = prepareResolvedFilamentState({
    config: { filament_type: 'PLA-S', nozzle_temperature: '250' },
    baseConfig: { filament_type: ['PLA'], nozzle_temperature: ['220'] },
    overriddenKeys: []
  } as never)
  assert.deepEqual(resolvedFilamentModifiedKeys(state), ['nozzle_temperature'])
})

test("a preset's own overrides are attributed to the preset, not to the project", async () => {
  const { prepareResolvedFilamentState, resolvedFilamentModifiedKeys, resolvedFilamentPresetOverrideKeys } =
    await import('./filament-settings.js')
  // A workspace custom preset in use by a project, untouched: its values ARE the baseline, and the
  // raised bed temp it carries belongs to the preset (its parent says 40). Reported as a project
  // change, it came with a reset button that would have discarded the user's own preset value.
  const state = prepareResolvedFilamentState({
    config: { hot_plate_temp: '55', nozzle_temperature: '255' },
    baseConfig: { hot_plate_temp: '55', nozzle_temperature: '255' },
    parentConfig: { hot_plate_temp: '40', nozzle_temperature: '255' },
    overriddenKeys: []
  })

  assert.deepEqual(resolvedFilamentModifiedKeys(state), [], 'nothing has been changed HERE')
  assert.deepEqual(resolvedFilamentPresetOverrideKeys(state), ['hot_plate_temp'], 'the preset carries it')

  // Changing it in the project is a project change, and stays distinct from the preset's override.
  assert.deepEqual(resolvedFilamentModifiedKeys(state, { hot_plate_temp: '60' }), ['hot_plate_temp'])
})

test('an installed preset with no parent attributes nothing to the preset', async () => {
  const { prepareResolvedFilamentState, resolvedFilamentModifiedKeys, resolvedFilamentPresetOverrideKeys } =
    await import('./filament-settings.js')
  // A builtin: no parent resolves, so the distinction collapses rather than being invented.
  const state = prepareResolvedFilamentState({
    config: { nozzle_temperature: '255' },
    baseConfig: { nozzle_temperature: '255' },
    overriddenKeys: []
  })

  assert.deepEqual(resolvedFilamentPresetOverrideKeys(state), [])
  assert.deepEqual(resolvedFilamentModifiedKeys(state), [], 'a preset cannot differ from itself')
  // ...and a heal override that restores the preset value must not read as a change (the badge's
  // old fallback counted override KEYS here, so a fully reset material still showed a count).
  assert.deepEqual(resolvedFilamentModifiedKeys(state, { nozzle_temperature: '255' }), [])
})

// Regression (2026-07-28, observed on "Best Shot Golf (PETG)" slot 1 against a dual-nozzle target):
// a filament value is stored PER EXTRUDER VARIANT, and every comparison here collapsed to element 0.
// The project carried max volumetric speed ["25","25"] under a preset saying ["25","40"] — equal on
// element 0, so no badge, no yellow, no reset button, while the second extruder sliced at 25.
test('per-variant drift past element 0 is a change; a scalar still means "same for every variant"', async () => {
  const { prepareResolvedFilamentState, resolvedFilamentModifiedKeys, filamentVariantValuesEqual } =
    await import('./filament-settings.js')
  const speed = filamentSettingsCatalog.options.filament_max_volumetric_speed

  // The observed case: same first variant, different second.
  assert.equal(filamentVariantValuesEqual(['25', '25'], ['25', '40'], speed), false)
  // A scalar broadcasts, so it equals a vector only when it equals EVERY element.
  assert.equal(filamentVariantValuesEqual('25', ['25', '25'], speed), true)
  assert.equal(filamentVariantValuesEqual('25', ['25', '40'], speed), false)
  // Value-equality stays option-aware per element, not string-exact.
  assert.equal(filamentVariantValuesEqual(['100', '100'], ['100%', '100%'], filamentSettingsCatalog.options.filament_shrink), true)

  const state = prepareResolvedFilamentState({
    config: { filament_max_volumetric_speed: ['25', '25'], nozzle_temperature: '245' },
    baseConfig: { filament_max_volumetric_speed: ['25', '40'], nozzle_temperature: ['245', '245'] },
    overriddenKeys: []
  })
  // The second variant's drift reports; the scalar temperature matching both variants does not.
  assert.deepEqual(resolvedFilamentModifiedKeys(state), ['filament_max_volumetric_speed'])
})

test('resetting a per-variant drift emits an override, so the reset button is not a no-op', async () => {
  const { diffFilamentVariantConfig } = await import('./filament-settings.js')
  // What the dialog does on reset: write the PRESET's per-variant value over the project's, then
  // diff against the effective base. The element-0 diff saw "25" both sides and emitted nothing,
  // which would have left a flagged setting whose reset visibly did nothing.
  const effective = { filament_max_volumetric_speed: ['25', '25'] }
  const reset = { filament_max_volumetric_speed: ['25', '40'] }
  assert.deepEqual(diffFilamentVariantConfig(effective, reset), { filament_max_volumetric_speed: ['25', '40'] })
  // An untouched key emits nothing, whichever shape it is stored in.
  assert.deepEqual(diffFilamentVariantConfig({ nozzle_temperature: ['245', '245'] }, { nozzle_temperature: '245' }), {})
})

// Ryan, 2026-07-28: "If I replace my PETG-HF with PLA Basic I get settings carried over - I
// absolutely should not. Nothing should carry between preset changes when changing materials."
// Confirmed against BambuStudio: Tab::select_preset sets `no_transfer = true` when the selected
// filament preset's `filament_type` differs from the edited one's (and always for the printer tab),
// while the transfer option is only offered on the PRINT tab.
test('a project slot\'s values carry to a same-type preset only, per BambuStudio select_preset', async () => {
  const { filamentSlotValuesCarryTo } = await import('./filament-settings.js')
  const petgSlot = { filament_type: 'PETG', nozzle_temperature: ['245', '245'] }

  assert.equal(filamentSlotValuesCarryTo(petgSlot, { filament_type: ['PLA'] }), false, 'PETG -> PLA carries nothing')
  assert.equal(filamentSlotValuesCarryTo(petgSlot, { filament_type: ['PETG'] }), true, 'PETG -> PETG keeps the slot')
  // Types are compared DERIVED, so a support filament is its own material (PLA-S is not PLA).
  const supportSlot = { filament_type: 'PLA', filament_is_support: '1', filament_ids: 'GFS00' }
  assert.equal(filamentSlotValuesCarryTo(supportSlot, { filament_type: ['PLA'] }), false, 'PLA-S -> PLA carries nothing')
  assert.equal(
    filamentSlotValuesCarryTo(supportSlot, { filament_type: ['PLA'], filament_is_support: ['1'], filament_ids: ['GFS00'] }),
    true,
    'PLA-S -> PLA-S keeps the slot'
  )
  // With no type to compare, keep the slot rather than silently discarding a project's real values.
  assert.equal(filamentSlotValuesCarryTo({ nozzle_temperature: '245' }, { filament_type: ['PLA'] }), true)
})
