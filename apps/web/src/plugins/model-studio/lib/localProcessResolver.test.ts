import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildBuiltinSlicingPresetId, buildProjectSlicingPresetId, type ResolveProcessConfigResponse, type SlicingPresetSummary } from '@printstream/shared'
import type { ClientThreeMfProject } from './clientThreeMfProject'
import { buildLocalProcessConfigResolver } from './localProcessResolver'

const A1_BUILTIN = buildBuiltinSlicingPresetId('process', '0.20mm Standard @BBL A1')

function projectWith(projectSettings: unknown): ClientThreeMfProject {
  const json = projectSettings === undefined ? null : JSON.stringify(projectSettings)
  return { archive: { indexEntries: () => ({ projectSettingsJson: json }) } } as unknown as ClientThreeMfProject
}

/** A built-in resolver that records its calls and returns a canned config. */
function stubBuiltin(config: Record<string, string | string[]>) {
  const calls: Array<{ id: string; targetId: string | null }> = []
  const resolveBuiltin = async (id: string, targetId: string | null): Promise<ResolveProcessConfigResponse> => {
    calls.push({ id, targetId })
    return { config, baseConfig: config, overriddenKeys: [] }
  }
  return { calls, resolveBuiltin }
}

const a1Profile: SlicingPresetSummary = { id: A1_BUILTIN, source: 'builtin', kind: 'process', name: '0.20mm Standard @BBL A1' } as SlicingPresetSummary

test('a builtin id resolves straight through the endpoint', async () => {
  const { calls, resolveBuiltin } = stubBuiltin({ wall_loops: '2' })
  const resolver = buildLocalProcessConfigResolver({ project: projectWith({}), processProfiles: [a1Profile], resolveBuiltin })
  const result = await resolver({ processProfileId: A1_BUILTIN, targetId: 't1', sourceFileId: null })
  assert.deepEqual(calls, [{ id: A1_BUILTIN, targetId: 't1' }])
  assert.deepEqual(result, { config: { wall_loops: '2' }, baseConfig: { wall_loops: '2' }, overriddenKeys: [] })
})

test('a project preset resolves its baseline from the in-tab config + a name-matched builtin', async () => {
  // The project set wall_loops=4 over the A1 baseline (2); the baseline resolves by NAME to the A1
  // builtin, so config is the project's and baseConfig is the resolved baseline (diff = wall_loops).
  const { calls, resolveBuiltin } = stubBuiltin({ wall_loops: '2' })
  const project = projectWith({ print_settings_id: '0.20mm Standard @BBL A1', wall_loops: '4', different_settings_to_system: ['wall_loops'] })
  const resolver = buildLocalProcessConfigResolver({ project, processProfiles: [a1Profile], resolveBuiltin })
  const result = await resolver({ processProfileId: buildProjectSlicingPresetId('process', '0.20mm Standard @BBL A1'), targetId: 't1', sourceFileId: null })
  assert.equal(calls[0]?.id, A1_BUILTIN, 'the parent builtin was resolved by name')
  assert.equal(result.config.wall_loops, '4')
  assert.equal(result.baseConfig.wall_loops, '2')
  // The file's declared record rides along even though the baseline resolved: it is what says the
  // difference was the user's doing rather than drift between the file and a since-updated preset.
  assert.deepEqual(result.overriddenKeys, ['wall_loops'])
  assert.equal(result.declaresOverrides, true)
})

test('a custom project preset resolves its baseline from the STANDARD parent (prefix match)', async () => {
  // "…H2D - Ryan" is a workspace custom preset unavailable here; its baseline is the built-in parent
  // "…H2D" (longest built-in name that is a prefix at a word boundary). Diff is then vs the standard.
  const { calls, resolveBuiltin } = stubBuiltin({ wall_loops: '2', top_shell_layers: '5' })
  const project = projectWith({ print_settings_id: '0.20mm Standard @BBL H2D - Ryan', wall_loops: '3', top_shell_layers: '5', different_settings_to_system: ['wall_loops'] })
  const catalogue: SlicingPresetSummary[] = [
    { id: buildBuiltinSlicingPresetId('process', '0.20mm Standard @BBL H2D'), source: 'builtin', kind: 'process', name: '0.20mm Standard @BBL H2D' } as SlicingPresetSummary,
    { id: buildBuiltinSlicingPresetId('process', '0.20mm Standard @BBL H2C'), source: 'builtin', kind: 'process', name: '0.20mm Standard @BBL H2C' } as SlicingPresetSummary
  ]
  const resolver = buildLocalProcessConfigResolver({ project, processProfiles: catalogue, resolveBuiltin })
  const result = await resolver({ processProfileId: buildProjectSlicingPresetId('process', '0.20mm Standard @BBL H2D - Ryan'), targetId: 't1', sourceFileId: null })
  assert.equal(calls[0]?.id, buildBuiltinSlicingPresetId('process', '0.20mm Standard @BBL H2D'), 'the H2D parent (not H2C) was resolved')
  assert.equal(result.baseConfig.wall_loops, '2', 'baseline is the standard parent')
  // Was asserted as "diff is computed, not the recorded list" — the inversion this now corrects.
  // top_shell_layers matches the parent and is undeclared, so only wall_loops is a real change.
  assert.deepEqual(result.overriddenKeys, ['wall_loops'], 'the recorded list is carried, not discarded')
  assert.equal(result.declaresOverrides, true)
})

test('a project preset whose parent is not in the catalogue falls back to the 3MF changed-from-system keys', async () => {
  const { calls, resolveBuiltin } = stubBuiltin({ wall_loops: '2' })
  const project = projectWith({ print_settings_id: 'Some Vendor Preset', wall_loops: '4', different_settings_to_system: ['wall_loops'] })
  // Catalogue has no builtin named "Some Vendor Preset".
  const resolver = buildLocalProcessConfigResolver({ project, processProfiles: [a1Profile], resolveBuiltin })
  const result = await resolver({ processProfileId: buildProjectSlicingPresetId('process', 'Some Vendor Preset'), targetId: null, sourceFileId: null })
  assert.equal(calls.length, 0, 'no baseline resolve when the parent is not installed')
  assert.equal(result.config.wall_loops, '4')
  assert.equal(result.baseConfig.wall_loops, '4', 'baseConfig falls back to the effective config')
  assert.deepEqual(result.overriddenKeys, ['wall_loops'])
})

test('a project preset with an unreadable config throws', async () => {
  const { resolveBuiltin } = stubBuiltin({})
  const project = { archive: { indexEntries: () => ({ projectSettingsJson: '{ not json' }) } } as unknown as ClientThreeMfProject
  const resolver = buildLocalProcessConfigResolver({ project, processProfiles: [], resolveBuiltin })
  await assert.rejects(resolver({ processProfileId: buildProjectSlicingPresetId('process', 'x'), targetId: null, sourceFileId: null }))
})

test('a workspace/custom id is not resolvable on an anonymous host', async () => {
  const { resolveBuiltin } = stubBuiltin({})
  const resolver = buildLocalProcessConfigResolver({ project: projectWith({}), processProfiles: [], resolveBuiltin })
  await assert.rejects(resolver({ processProfileId: 'custom:whatever', targetId: null, sourceFileId: null }))
})

/** Run a body with browser storage present, holding the given stored presets. */
async function withLocalPresetStore(stored: unknown[], body: () => Promise<void>) {
  const host = globalThis as { window?: unknown }
  const original = host.window
  host.window = { localStorage: { getItem: () => JSON.stringify(stored) } }
  try {
    await body()
  } finally {
    if (original === undefined) delete host.window
    else host.window = original
  }
}

test('a browser-stored process preset resolves by flattening onto its builtin parent', async () => {
  // The filament resolver grew this branch first; without the process twin, a project that
  // SELECTED a stored process preset dead-ended the tune dialog on "could not be resolved".
  const { calls, resolveBuiltin } = stubBuiltin({ wall_loops: '2', top_shell_layers: '5' })
  const stored = [{
    id: 'local:process:0.20mm Ryan @BBL A1',
    kind: 'process',
    name: '0.20mm Ryan @BBL A1',
    raw: { inherits: '0.20mm Standard @BBL A1', wall_loops: '4' },
    addedAt: ''
  }]
  await withLocalPresetStore(stored, async () => {
    const resolver = buildLocalProcessConfigResolver({ project: projectWith({}), processProfiles: [a1Profile], resolveBuiltin })
    const result = await resolver({ processProfileId: 'local:process:0.20mm Ryan @BBL A1', targetId: 't1', sourceFileId: null })
    assert.equal(calls[0]?.id, A1_BUILTIN, 'the declared parent was resolved as a builtin')
    assert.equal(result.config.wall_loops, '4', "the preset's own delta wins")
    assert.equal(result.config.top_shell_layers, '5', 'the parent fills the keys the delta omits')
    assert.equal(result.baseConfig.wall_loops, '4', 'an installed preset is its own baseline')
    assert.equal(result.parentConfig?.wall_loops, '2', "the parent's values ride along as emphasis only")
    assert.deepEqual(result.overriddenKeys, [], 'nothing is "changed" until the user edits')
  })
})

test('a stored process preset of the WRONG kind does not shadow the id space', async () => {
  // The store holds one entry per (kind, name); a filament preset must never answer a process id.
  const { resolveBuiltin } = stubBuiltin({})
  const stored = [{ id: 'local:process:X', kind: 'filament', name: 'X', raw: {}, addedAt: '' }]
  await withLocalPresetStore(stored, async () => {
    const resolver = buildLocalProcessConfigResolver({ project: projectWith({}), processProfiles: [], resolveBuiltin })
    await assert.rejects(resolver({ processProfileId: 'local:process:X', targetId: null, sourceFileId: null }))
  })
})
