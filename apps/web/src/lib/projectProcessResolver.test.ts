import assert from 'node:assert/strict'
import test from 'node:test'
import { projectProcessResolver } from './projectProcessResolver'
import { buildProjectSlicingPresetId, type SlicingPresetSummary } from '@printstream/shared'
const selected: SlicingPresetSummary = { id: 'custom:ryan', name: 'Ryan', source: 'custom', kind: 'process' }
const request = { processProfileId: buildProjectSlicingPresetId('process', 'Ryan'), targetId: 'engine-a', sourceFileId: 'same-library-row' }

test('the archive supplies effective values; the catalogue supplies only leaf and parent baselines', async () => {
  const resolve = projectProcessResolver({
    readSettings: async () => JSON.stringify({ print_settings_id: 'Ryan', wall_loops: '5', inherits_group: ['Standard', '', ''], different_settings_to_system: ['', '', ''] }),
    profiles: () => [selected], resolveInstalled: async () => ({ preset: { name: 'Ryan', parentName: 'Standard' },
      config: { wall_loops: '4' }, baseConfig: { wall_loops: '4' }, parentConfig: { wall_loops: '2' }, overriddenKeys: [] })
  })
  const response = await resolve(request)
  assert.equal(response.config.wall_loops, '5')
  assert.equal(response.baseConfig.wall_loops, '4')
  assert.equal(response.parentConfig?.wall_loops, '2')
  assert.deepEqual(response.overriddenKeys, [])
})

test('two sessions of the same preset name and library row never share project data', async () => {
  const open = (walls: string) => projectProcessResolver({ readSettings: async () => JSON.stringify({ print_settings_id: 'Ryan', wall_loops: walls }),
    profiles: () => [selected], resolveInstalled: async () => ({ config: { wall_loops: '2' }, baseConfig: { wall_loops: '2' }, overriddenKeys: [] }) })
  assert.equal((await open('4')(request)).config.wall_loops, '4')
  assert.equal((await open('6')(request)).config.wall_loops, '6')
})

test('the selected baseline is pinned per engine through switch, save and slice resolution', async () => {
  let currentWalls = '4'
  let calls = 0
  const resolve = projectProcessResolver({ readSettings: async () => '{}', profiles: () => [], resolveInstalled: async () => {
    ++calls
    return { config: { wall_loops: currentWalls }, baseConfig: { wall_loops: currentWalls }, overriddenKeys: [] }
  } })
  const selection = { ...request, processProfileId: selected.id }
  assert.equal((await resolve(selection)).config.wall_loops, '4')
  currentWalls = '8'
  assert.equal((await resolve(selection)).config.wall_loops, '4')
  assert.equal(calls, 1)
  assert.equal((await resolve({ ...selection, targetId: 'engine-b' })).config.wall_loops, '8')
})

test('missing baselines preserve effective values, including files with an empty changed record', async () => {
  const resolve = projectProcessResolver({ readSettings: async () => JSON.stringify({ print_settings_id: 'Deleted', wall_loops: '5', different_settings_to_system: ['', '', ''] }),
    profiles: () => [], resolveInstalled: async () => { throw new Error('not installed') } })
  const response = await resolve(request)
  assert.equal(response.config.wall_loops, '5')
  assert.equal(response.baselineResolved, false)
})

test('loaded source values survive switching to an engine without that preset', async () => {
  const { memoizeProcessPresetResolver } = await import('./projectProcessResolver')
  const resolve = memoizeProcessPresetResolver(async ({ targetId }) => {
    if (targetId === 'new-engine') throw new Error('preset unavailable')
    return { config: { wall_loops: '2', support_filament: '3' }, baseConfig: { wall_loops: '2' }, overriddenKeys: [] }
  })
  await resolve({ ...request, processProfileId: selected.id })
  const source = await resolve.resolveSource!({ ...request, processProfileId: selected.id, targetId: 'new-engine' })
  assert.equal(source.config.wall_loops, '2')
  assert.equal(resolve.peekSource!(selected.id)?.config.support_filament, '3')
  await assert.rejects(() => resolve({ ...request, processProfileId: selected.id, targetId: 'new-engine' }), /unavailable/)
  assert.equal(resolve.peekSource!(selected.id)?.config.support_filament, '3')
})

test('an opened dual-nozzle project compares with the corresponding columns of its full custom preset', async () => {
  const { deriveProjectCarryOverrides } = await import('./processCarryOverrides')
  const { resolvedProcessModifiedKeys } = await import('@printstream/shared')
  const standard = 'Direct Drive Standard'
  const high = 'Direct Drive High Flow'
  const e3d = 'Direct Drive E3D High Flow'
  const config = {
    print_extruder_id: ['1', '1', '1', '2', '2', '2', '2'],
    print_extruder_variant: [standard, high, e3d, standard, high, 'Direct Drive TPU High Flow', e3d],
    initial_layer_speed: ['50', '50', '50', '50', '50', '50', '50'],
    outer_wall_speed: ['200', '500', '500', '210', '510', '520', '530'],
    support_interface_speed: ['80', '80', '80', '80', '80', '80', '80']
  }
  const resolve = projectProcessResolver({
    readSettings: async () => JSON.stringify({
      print_settings_id: 'Ryan', print_extruder_id: ['1', '2'], print_extruder_variant: [standard, standard],
      initial_layer_speed: ['50', '50'], outer_wall_speed: ['200', '210'], support_interface_speed: ['50', '50']
    }),
    profiles: () => [selected],
    resolveInstalled: async () => ({ config, baseConfig: config, overriddenKeys: [] })
  })
  const response = await resolve(request)
  assert.deepEqual(response.config.print_extruder_id, ['1', '2'])
  assert.deepEqual(resolvedProcessModifiedKeys(response), ['support_interface_speed'])
  assert.deepEqual(deriveProjectCarryOverrides(response), { support_interface_speed: ['50', '50'] })
  assert.deepEqual(deriveProjectCarryOverrides(response, { support_interface_speed: ['80', '80'] }), {})
  const installed = await resolve({ ...request, processProfileId: selected.id })
  assert.equal(installed.config.initial_layer_speed?.length, 7, 'comparison never truncates the pinned installed preset')
})
