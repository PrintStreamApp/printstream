import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { ResolveProcessConfigResponse, SlicingPresetSummary } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'
const dom = installJsdomGlobals()
const React = (await import('react')).default
const { cleanup, fireEvent, render, screen, waitFor, act } = await import('@testing-library/react')
const { AppThemeProvider } = await import('../../theme/AppThemeProvider')
const { theme } = await import('../../theme/theme')
const { ProcessPresetPicker } = await import('./ProcessPresetPicker')
afterEach(() => cleanup())
after(() => dom.window.close())
const profiles: SlicingPresetSummary[] = [
  { id: 'custom:old', source: 'custom', kind: 'process', name: 'Old preset' },
  { id: 'custom:new', source: 'custom', kind: 'process', name: 'New preset' }
]
const source: ResolveProcessConfigResponse = { config: { wall_loops: '4', sparse_infill_pattern: '3dhoneycomb' },
  baseConfig: { wall_loops: '2', sparse_infill_pattern: '3dhoneycomb' },
  parentConfig: { sparse_infill_pattern: 'grid' }, overriddenKeys: ['wall_loops', 'sparse_infill_pattern'] }
const destination: ResolveProcessConfigResponse = { config: { wall_loops: '3' }, baseConfig: { wall_loops: '3' }, overriddenKeys: [] }
function mount(extra: Partial<React.ComponentProps<typeof ProcessPresetPicker>> = {}) {
  const commits: unknown[] = []
  const props = { profiles, value: profiles[0]!, targetId: 'engine', overrides: {},
    resolveConfig: async ({ processProfileId }: { processProfileId: string }) => processProfileId === profiles[0]!.id ? source : destination,
    onChange: (id: string, overrides: unknown) => commits.push({ id, overrides }), ...extra }
  const tree = (changes = {}) => <AppThemeProvider theme={theme}><ProcessPresetPicker {...props} {...changes} /></AppThemeProvider>
  const view = render(tree())
  return { commits, view, tree }
}
async function selectNext() {
  fireEvent.mouseDown(screen.getByRole('combobox'))
  fireEvent.click(await screen.findByRole('option', { name: 'New preset' }))
}
for (const choice of ['Keep changes', 'Discard changes', 'Cancel']) {
  test(`switch: ${choice} is explicit and commits at most once`, async () => {
    const { commits } = mount()
    await selectNext()
    const button = await screen.findByRole('button', { name: choice })
    assert.deepEqual(commits, [], 'no host state or history mutation before the decision')
    fireEvent.click(button)
    await act(async () => {})
    assert.deepEqual(commits, choice === 'Cancel' ? [] : [{ id: 'custom:new', overrides: choice === 'Keep changes' ? { wall_loops: '4' } : {} }])
  })
}
test('a reset baked value is not pinned over the destination baseline', async () => {
  const { commits } = mount({ overrides: { wall_loops: '2' } })
  await selectNext()
  await waitFor(() => assert.deepEqual(commits, [{ id: 'custom:new', overrides: {} }]))
  assert.equal(screen.queryByRole('dialog'), null)
})
test('unapplied dialog values participate in Keep', async () => {
  const { commits } = mount({ effectiveConfig: { ...source.config, wall_loops: '5' } })
  await selectNext()
  fireEvent.click(await screen.findByRole('button', { name: 'Keep changes' }))
  assert.deepEqual(commits, [{ id: 'custom:new', overrides: { wall_loops: '5' } }])
})

for (const unknownLayout of [false, true]) {
  test(`Keep through final save/slice preserves nozzle tuning without transferring topology (unknown layout: ${unknownLayout})`, async () => {
    const { applyProcessProfileToProjectSettings, buildBuiltinSlicingPresetId } = await import('@printstream/shared')
    const { processSettingsForSave } = await import('../../plugins/model-studio/lib/clientProcessSettingsPass')
    const standard = 'Direct Drive Standard'
    const high = 'Direct Drive High Flow'
    const installed = {
      print_extruder_id: ['1', '1', '2', '2'], print_extruder_variant: [standard, high, standard, high],
      outer_wall_speed: ['200', '500', '210', '510'], support_interface_speed: ['80', '80', '80', '80']
    }
    const opened = {
      print_extruder_id: ['1', '2'], print_extruder_variant: [standard, unknownLayout ? 'Unknown flow' : standard],
      outer_wall_speed: ['200', '210'], support_interface_speed: ['50', '50']
    }
    const target: ResolveProcessConfigResponse = {
      config: installed, baseConfig: installed, overriddenKeys: [], preset: { name: 'New preset', parentName: null }
    }
    let kept: Record<string, string | string[]> | undefined
    mount({
      resolveConfig: async ({ processProfileId }) => processProfileId === profiles[0]!.id
        ? { config: opened, baseConfig: installed, overriddenKeys: [] } : target,
      onChange: (_id, overrides) => { kept = overrides }
    })
    await selectNext()
    fireEvent.click(await screen.findByRole('button', { name: 'Keep changes' }))
    assert.ok(kept)
    assert.equal(kept.print_extruder_id, undefined)
    assert.equal(kept.print_extruder_variant, undefined)
    if (!unknownLayout) assert.deepEqual(kept, { support_interface_speed: ['50', '50'] })

    const machine = { printer_extruder_id: ['1', '2'], printer_extruder_variant: [standard, standard] }
    const save = processSettingsForSave({
      mode: 'manualProfile', printerModel: 'Bambu Lab H2D', nozzleDiameters: [0.4, 0.4],
      printerProfileId: buildBuiltinSlicingPresetId('machine', 'Bambu Lab H2D 0.4 nozzle'),
      processProfileId: profiles[1]!.id, processProfileChosen: true, processSettingOverrides: kept
    }, null, {
      resolvers: { canResolve: () => true, process: async () => target,
        machine: async () => ({ config: {}, name: 'Machine' }), filament: async () => target },
      filamentPresets: async () => []
    })
    const saved = await save(machine)
    const sliced = applyProcessProfileToProjectSettings(machine, installed, kept, { name: 'New preset', parentName: null })
    for (const output of [saved, sliced]) {
      assert.deepEqual(output.outer_wall_speed, ['200', '210'])
      assert.deepEqual(output.support_interface_speed, ['50', '50'])
      assert.deepEqual(output.print_extruder_id, machine.printer_extruder_id)
      assert.deepEqual(output.print_extruder_variant, machine.printer_extruder_variant)
    }
  })
}

test('undo or a project change invalidates a delayed preset lookup', async () => {
  let finish!: (value: ResolveProcessConfigResponse) => void
  const pending = new Promise<ResolveProcessConfigResponse>((resolve) => { finish = resolve })
  const { commits, view, tree } = mount({ resolveConfig: async () => pending })
  await selectNext()
  view.rerender(tree({ overrides: { wall_loops: '2' }, sourceFileId: 'other-project' }))
  await act(async () => { finish(destination) })
  assert.deepEqual(commits, [])
  assert.equal(screen.queryByRole('dialog'), null)
})
test('failure keeps the current selection and edits', async () => {
  const { commits } = mount({ resolveConfig: async () => { throw new Error('Offline') } })
  await selectNext()
  assert.equal((await screen.findByRole('alert')).textContent, 'Offline')
  assert.deepEqual(commits, [])
})

test('choosing the same preset is a no-op, including resolution and history', async () => {
  let calls = 0
  const { commits } = mount({ resolveConfig: async () => { ++calls; return source } })
  await waitFor(() => assert.equal(calls, 1))
  const before = calls
  fireEvent.mouseDown(screen.getByRole('combobox'))
  fireEvent.click(await screen.findByRole('option', { name: 'Old preset' }))
  await act(async () => {})
  assert.equal(calls, before)
  assert.deepEqual(commits, [])
})

test('a completed lookup after closing the picker cannot commit a selection', async () => {
  let finish!: (value: ResolveProcessConfigResponse) => void
  const pending = new Promise<ResolveProcessConfigResponse>((resolve) => { finish = resolve })
  const { commits, view } = mount({ resolveConfig: async () => pending })
  await selectNext()
  view.unmount()
  await act(async () => { finish(destination) })
  assert.deepEqual(commits, [])
})

test('an unavailable source baseline offers an explicit conservative Keep for saved values', async () => {
  const missing: ResolveProcessConfigResponse = { config: { wall_loops: '5' }, baseConfig: { wall_loops: '5' }, overriddenKeys: [], baselineResolved: false }
  const { commits } = mount({ resolveConfig: async ({ processProfileId }) => processProfileId === profiles[0]!.id ? missing : destination })
  await selectNext()
  const keep = await screen.findByRole('button', { name: 'Keep changes' })
  assert.ok(screen.getByText(/original preset is unavailable/))
  fireEvent.click(keep)
  assert.deepEqual(commits, [{ id: 'custom:new', overrides: { wall_loops: '5' } }])
})

test('Discard remains available when the old preset cannot resolve in the current engine', async () => {
  const { commits } = mount({ resolveConfig: async ({ processProfileId }) => {
    if (processProfileId === profiles[0]!.id) throw new Error('old preset unavailable')
    return destination
  } })
  await selectNext()
  const discard = await screen.findByRole('button', { name: 'Discard changes' })
  assert.equal((screen.getByRole('button', { name: 'Keep changes' }) as HTMLButtonElement).disabled, true)
  fireEvent.click(discard)
  assert.deepEqual(commits, [{ id: 'custom:new', overrides: {} }])
})

test('Keep uses the loaded source descriptor across an engine change', async () => {
  const { memoizeProcessPresetResolver } = await import('../../lib/projectProcessResolver')
  const resolver = memoizeProcessPresetResolver(async ({ processProfileId, targetId }) => {
    if (processProfileId === profiles[0]!.id) {
      if (targetId === 'new-engine') throw new Error('unavailable')
      return source
    }
    return destination
  })
  const { commits, view, tree } = mount({ resolveConfig: resolver, overrides: { wall_loops: '5' } })
  await waitFor(() => assert.ok(resolver.peekSource!(profiles[0]!.id)))
  view.rerender(tree({ targetId: 'new-engine' }))
  await selectNext()
  fireEvent.click(await screen.findByRole('button', { name: 'Keep changes' }))
  assert.deepEqual(commits, [{ id: 'custom:new', overrides: { wall_loops: '5' } }])
})


test('dialog switching after engine A -> B -> A uses the displayed A baseline', async () => {
  const { memoizeProcessPresetResolver } = await import('../../lib/projectProcessResolver')
  const resolver = memoizeProcessPresetResolver(async ({ processProfileId, targetId }) => {
    const wall_loops = processProfileId === profiles[0]!.id ? (targetId === 'engine-a' ? '2' : '3') : '5'
    return { config: { wall_loops }, baseConfig: { wall_loops }, overriddenKeys: [] }
  })
  const request = { processProfileId: profiles[0]!.id, targetId: 'engine-a', sourceFileId: null }
  await resolver(request)
  await resolver({ ...request, targetId: 'engine-b' })
  // The dialog first loads its displayed config using the regular resolver, then mounts its picker.
  const displayed = await resolver(request)
  assert.equal(displayed.config.wall_loops, '2')
  const { commits } = mount({ targetId: 'engine-a', resolveConfig: resolver, effectiveConfig: displayed.config })
  await selectNext()
  await waitFor(() => assert.deepEqual(commits, [{ id: 'custom:new', overrides: {} }]))
  assert.equal(screen.queryByRole('dialog'), null, 'untouched displayed values cannot manufacture a modification')
})


test('dialog activation supersedes a picker warm-up from the previous engine', async () => {
  const { memoizeProcessPresetResolver } = await import('../../lib/projectProcessResolver')
  const resolver = memoizeProcessPresetResolver(async ({ processProfileId, targetId }) => {
    const wall_loops = processProfileId === profiles[0]!.id ? (targetId === 'engine-a' ? '2' : '3') : '5'
    return { config: { wall_loops }, baseConfig: { wall_loops }, overriddenKeys: [] }
  })
  const request = { processProfileId: profiles[0]!.id, targetId: 'engine-a', sourceFileId: null }
  await resolver(request)
  await resolver({ ...request, targetId: 'engine-b' })
  const { commits } = mount({ targetId: 'engine-a', resolveConfig: resolver, effectiveConfig: { wall_loops: '2' } })
  await act(async () => {})
  // Parent effects can activate the displayed engine after child warm-up has retained B.
  await act(async () => { await resolver(request) })
  await selectNext()
  await waitFor(() => assert.deepEqual(commits, [{ id: 'custom:new', overrides: {} }]))
})
