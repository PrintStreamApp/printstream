import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildBuiltinSlicingPresetId, buildProjectSlicingPresetId, type ResolveFilamentConfigResponse, type SlicingPresetSummary } from '@printstream/shared'
import type { ClientThreeMfProject } from './clientThreeMfProject'
import { buildLocalFilamentConfigResolver } from './localFilamentResolver'

const PETG_BUILTIN = buildBuiltinSlicingPresetId('filament', 'Bambu PETG Basic')

function projectWith(projectSettings: unknown): ClientThreeMfProject {
  const json = projectSettings === undefined ? null : JSON.stringify(projectSettings)
  return { archive: { indexEntries: () => ({ projectSettingsJson: json }) } } as unknown as ClientThreeMfProject
}

/** A built-in filament resolver that records its calls and returns a canned config. */
function stubBuiltin(config: Record<string, string | string[]>) {
  const calls: Array<{ id: string; targetId: string | null }> = []
  const resolveBuiltin = async (id: string, targetId: string | null): Promise<ResolveFilamentConfigResponse> => {
    calls.push({ id, targetId })
    return { config, baseConfig: config, overriddenKeys: [] }
  }
  return { calls, resolveBuiltin }
}

const petgProfile: SlicingPresetSummary = { id: PETG_BUILTIN, source: 'builtin', kind: 'filament', name: 'Bambu PETG Basic' } as SlicingPresetSummary

test('a builtin filament id resolves straight through the endpoint', async () => {
  const { calls, resolveBuiltin } = stubBuiltin({ nozzle_temperature: '250' })
  const resolver = buildLocalFilamentConfigResolver({ project: projectWith({}), filamentProfiles: [petgProfile], resolveBuiltin })
  const result = await resolver({ filamentProfileId: PETG_BUILTIN, targetId: 't1', sourceFileId: null, projectFilamentId: 1 })
  assert.deepEqual(calls, [{ id: PETG_BUILTIN, targetId: 't1' }])
  assert.equal(result.config.nozzle_temperature, '250')
})

test('a project filament resolves its slot column + a name-matched builtin baseline', async () => {
  // The project raised nozzle_temperature to 270 in slot 1 over the PETG Basic baseline (250); the
  // baseline resolves by NAME to the builtin, so config is the project's and baseConfig the baseline.
  const { calls, resolveBuiltin } = stubBuiltin({ nozzle_temperature: '250' })
  const project = projectWith({
    filament_settings_id: ['Bambu PETG Basic'],
    nozzle_temperature: ['270'],
    different_settings_to_system: ['wall_loops', 'nozzle_temperature']
  })
  const resolver = buildLocalFilamentConfigResolver({ project, filamentProfiles: [petgProfile], resolveBuiltin })
  const result = await resolver({ filamentProfileId: buildProjectSlicingPresetId('filament', 'Bambu PETG Basic'), targetId: 't1', sourceFileId: null, projectFilamentId: 1 })
  assert.equal(calls[0]?.id, PETG_BUILTIN, 'the parent builtin was resolved by name')
  assert.equal(result.config.nozzle_temperature, '270')
  assert.equal(result.baseConfig.nozzle_temperature, '250')
  // Carried alongside the resolved baseline now — `wall_loops` is not a filament key, so the
  // catalogue filter drops it and only the real one survives.
  assert.deepEqual(result.overriddenKeys, ['nozzle_temperature'])
  assert.equal(result.declaresOverrides, true)
})

test('a custom project filament resolves its baseline from the STANDARD parent (prefix match)', async () => {
  // "…HF - Ryan" is a workspace custom preset unavailable here; its baseline is the built-in parent
  // "Bambu PETG HF" (longest built-in name that is a prefix at a word boundary).
  const { calls, resolveBuiltin } = stubBuiltin({ nozzle_temperature: '245' })
  const project = projectWith({
    filament_settings_id: ['Bambu PETG HF - Ryan'],
    nozzle_temperature: ['270'],
    different_settings_to_system: ['', 'nozzle_temperature']
  })
  const catalogue: SlicingPresetSummary[] = [
    { id: buildBuiltinSlicingPresetId('filament', 'Bambu PETG HF'), source: 'builtin', kind: 'filament', name: 'Bambu PETG HF' } as SlicingPresetSummary,
    { id: buildBuiltinSlicingPresetId('filament', 'Bambu PETG Basic'), source: 'builtin', kind: 'filament', name: 'Bambu PETG Basic' } as SlicingPresetSummary
  ]
  const resolver = buildLocalFilamentConfigResolver({ project, filamentProfiles: catalogue, resolveBuiltin })
  const result = await resolver({ filamentProfileId: buildProjectSlicingPresetId('filament', 'Bambu PETG HF - Ryan'), targetId: 't1', sourceFileId: null, projectFilamentId: 1 })
  assert.equal(calls[0]?.id, buildBuiltinSlicingPresetId('filament', 'Bambu PETG HF'), 'the HF parent (not Basic) was resolved')
  assert.equal(result.baseConfig.nozzle_temperature, '245', 'baseline is the standard parent')
})

test('a project filament whose parent is not in the catalogue falls back to the slot changed-from-system keys', async () => {
  const { calls, resolveBuiltin } = stubBuiltin({ nozzle_temperature: '250' })
  const project = projectWith({
    filament_settings_id: ['Some Vendor Filament'],
    nozzle_temperature: ['270'],
    different_settings_to_system: ['', 'nozzle_temperature']
  })
  const resolver = buildLocalFilamentConfigResolver({ project, filamentProfiles: [petgProfile], resolveBuiltin })
  const result = await resolver({ filamentProfileId: buildProjectSlicingPresetId('filament', 'Some Vendor Filament'), targetId: null, sourceFileId: null, projectFilamentId: 1 })
  assert.equal(calls.length, 0, 'no baseline resolve when the parent is not installed')
  assert.equal(result.config.nozzle_temperature, '270')
  assert.equal(result.baseConfig.nozzle_temperature, '270', 'baseConfig falls back to the effective config')
  assert.deepEqual(result.overriddenKeys, ['nozzle_temperature'])
})

test('a project filament with no slot index throws', async () => {
  const { resolveBuiltin } = stubBuiltin({})
  const resolver = buildLocalFilamentConfigResolver({ project: projectWith({ filament_settings_id: ['x'] }), filamentProfiles: [], resolveBuiltin })
  await assert.rejects(resolver({ filamentProfileId: buildProjectSlicingPresetId('filament', 'x'), targetId: null, sourceFileId: null, projectFilamentId: null }))
})

test('a project filament with an unreadable config throws', async () => {
  const { resolveBuiltin } = stubBuiltin({})
  const project = { archive: { indexEntries: () => ({ projectSettingsJson: '{ not json' }) } } as unknown as ClientThreeMfProject
  const resolver = buildLocalFilamentConfigResolver({ project, filamentProfiles: [], resolveBuiltin })
  await assert.rejects(resolver({ filamentProfileId: buildProjectSlicingPresetId('filament', 'x'), targetId: null, sourceFileId: null, projectFilamentId: 1 }))
})

test('a workspace/custom filament id is not resolvable on an anonymous host', async () => {
  const { resolveBuiltin } = stubBuiltin({})
  const resolver = buildLocalFilamentConfigResolver({ project: projectWith({}), filamentProfiles: [], resolveBuiltin })
  await assert.rejects(resolver({ filamentProfileId: 'custom:whatever', targetId: null, sourceFileId: null, projectFilamentId: 1 }))
})

// The workspace reports a slot's baked drift against the stock preset it names; the public editor reported
// none, because its builtin branch returned the preset and never looked at the file. Same project,
// same badge, whichever host opened it.
test('a builtin preset is measured against the slot the project actually carries', async () => {
  const { resolveBuiltin } = stubBuiltin({ filament_type: ['PETG'], filament_max_volumetric_speed: ['25', '40'] })
  // One filament, TWO extruder variants — `filament_extruder_variant` is the layout's identity
  // column, so without it the parser reads element 0 rather than the slot's 2-wide block.
  const project = projectWith({
    filament_settings_id: ['Bambu PETG Basic'],
    filament_extruder_variant: ['0', '1'],
    filament_type: ['PETG'],
    filament_max_volumetric_speed: ['25', '25']
  })
  const resolver = buildLocalFilamentConfigResolver({ project, filamentProfiles: [petgProfile], resolveBuiltin })
  const result = await resolver({ filamentProfileId: PETG_BUILTIN, targetId: 't1', sourceFileId: null, projectFilamentId: 1 })
  // config = what the project will slice with; baseConfig = the preset it is measured against.
  assert.deepEqual(result.config.filament_max_volumetric_speed, ['25', '25'])
  assert.deepEqual(result.baseConfig.filament_max_volumetric_speed, ['25', '40'])
})

test('a slot holding another material carries nothing to the preset', async () => {
  // BambuStudio's own rule (Tab::select_preset sets no_transfer on a filament_type change): PETG's
  // tuning must not follow the slot to a PLA preset.
  const { resolveBuiltin } = stubBuiltin({ filament_type: ['PLA'], nozzle_temperature: ['220'] })
  const project = projectWith({
    filament_settings_id: ['Bambu PETG Basic'],
    filament_type: ['PETG'],
    nozzle_temperature: ['245']
  })
  // (single-variant here: the point is the material mismatch, not the vector shape)
  const resolver = buildLocalFilamentConfigResolver({ project, filamentProfiles: [petgProfile], resolveBuiltin })
  const result = await resolver({ filamentProfileId: PETG_BUILTIN, targetId: 't1', sourceFileId: null, projectFilamentId: 1 })
  assert.deepEqual(result.config.nozzle_temperature, ['220'], 'the preset stands alone')
})

// Switching a slot onto a different preset. The project declares NO changes for this slot, so
// nothing follows it: the new preset's values stand and nothing reads as changed. Before, the whole
// slot config was dragged across and every key where it differed from the chosen preset was
// reported as this project's change — a stock slot moved onto a variant that touches two keys
// announced "2 changes" the user never made, and kept two numbers BambuStudio would have replaced
// (`Tab::select_preset` carries the dirty options only).
test('only the declared changes follow a slot onto a different preset', async () => {
  const { resolveBuiltin } = stubBuiltin({ supertack_plate_temp: '55', supertack_plate_temp_initial_layer: '55', nozzle_temperature: '220' })
  const project = projectWith({
    filament_settings_id: ['Bambu PLA Basic @BBL H2D'],
    filament_type: ['PLA'],
    supertack_plate_temp: ['40'],
    supertack_plate_temp_initial_layer: ['40'],
    nozzle_temperature: ['220'],
    different_settings_to_system: ['', '']
  })
  const resolver = buildLocalFilamentConfigResolver({ project, filamentProfiles: [], resolveBuiltin })

  const result = await resolver({
    filamentProfileId: buildBuiltinSlicingPresetId('filament', 'Bambu PLA Basic @BBL H2D - 55 degree plate'),
    targetId: 't1',
    sourceFileId: null,
    projectFilamentId: 1
  })

  assert.equal(result.config.supertack_plate_temp, '55', "the chosen preset's value, not the slot's undeclared 40")
  assert.equal(result.config.supertack_plate_temp_initial_layer, '55')
  assert.deepEqual(result.overriddenKeys, [], 'nothing declared, so nothing is a change')
  assert.equal(result.declaresOverrides, true)
})

// The inverse, and the reason this is gated: a file that recorded nothing has real overrides and an
// empty list, so its values must still carry wholesale rather than be silently dropped.
test('a slot with no declared record still carries its values onto a new preset', async () => {
  const { resolveBuiltin } = stubBuiltin({ supertack_plate_temp: '55', nozzle_temperature: '220' })
  const project = projectWith({
    filament_settings_id: ['Bambu PLA Basic @BBL H2D'],
    filament_type: ['PLA'],
    supertack_plate_temp: ['40'],
    nozzle_temperature: ['220']
  })
  const resolver = buildLocalFilamentConfigResolver({ project, filamentProfiles: [], resolveBuiltin })

  const result = await resolver({
    filamentProfileId: buildBuiltinSlicingPresetId('filament', 'Bambu PLA Basic @BBL H2D - 55 degree plate'),
    targetId: 't1',
    sourceFileId: null,
    projectFilamentId: 1
  })

  assert.equal(result.config.supertack_plate_temp, '40', 'undeclared but unknown — keep it rather than discard it')
  assert.equal(result.declaresOverrides, false, 'recorded nothing — not the same as recording that nothing changed')
})

/**
 * Which baseline the resolver settled on is REPORTED, not left for a caller to re-derive.
 *
 * The dialog turns `baselineOrigin` into the caveat it shows. It used to be computed separately in
 * the controller, which got it wrong twice over: it answered per PRESET while this answers per
 * SLOT, and it never looked at browser-stored presets at all — so the one case with a genuinely
 * incomplete baseline was the one case that said nothing.
 */
test('an exact built-in match reports an exact baseline, so the dialog stays quiet', async () => {
  const { resolveBuiltin } = stubBuiltin({ nozzle_temperature: '250' })
  const project = projectWith({ filament_settings_id: ['Bambu PETG Basic'], nozzle_temperature: ['270'] })
  const resolver = buildLocalFilamentConfigResolver({
    project,
    filamentProfiles: [{ ...petgProfile, name: 'Bambu PETG Basic' }],
    resolveBuiltin
  })
  const result = await resolver({
    filamentProfileId: buildProjectSlicingPresetId('filament', 'Bambu PETG Basic'),
    targetId: 't1', sourceFileId: null, projectFilamentId: 1
  })
  assert.deepEqual(result.baselineOrigin, { kind: 'exact' })
})

test('a standard parent standing in for a custom preset is reported BY NAME', async () => {
  const { resolveBuiltin } = stubBuiltin({ nozzle_temperature: '250' })
  // "<standard> - Ryan" is the shape BambuStudio gives a workspace custom preset.
  const project = projectWith({ filament_settings_id: ['Bambu PETG Basic - Ryan'], nozzle_temperature: ['270'] })
  const resolver = buildLocalFilamentConfigResolver({
    project,
    filamentProfiles: [{ ...petgProfile, name: 'Bambu PETG Basic' }],
    resolveBuiltin
  })
  const result = await resolver({
    filamentProfileId: buildProjectSlicingPresetId('filament', 'Bambu PETG Basic - Ryan'),
    targetId: 't1', sourceFileId: null, projectFilamentId: 1
  })
  // The NAME matters: the caveat tells the user which preset their markers are measured against.
  assert.deepEqual(result.baselineOrigin, { kind: 'parent', name: 'Bambu PETG Basic' })
})

test('nothing resolvable reports a declared baseline, not a comparison', async () => {
  const { resolveBuiltin } = stubBuiltin({ nozzle_temperature: '250' })
  const project = projectWith({ filament_settings_id: ['Something Entirely Renamed'], nozzle_temperature: ['270'] })
  const resolver = buildLocalFilamentConfigResolver({ project, filamentProfiles: [petgProfile], resolveBuiltin })
  const result = await resolver({
    filamentProfileId: buildProjectSlicingPresetId('filament', 'Something Entirely Renamed'),
    targetId: 't1', sourceFileId: null, projectFilamentId: 1
  })
  assert.deepEqual(result.baselineOrigin, { kind: 'declared' })
  assert.equal(result.baselineResolved, false, 'and the existing flag still says there was no diff source')
})
