import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { bridgeLibraryThreeMfIndexSchema, type SlicerFamily, type SlicingPresetSummary } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { ClientThreeMfProject } from './lib/clientThreeMfProject'

const dom = installJsdomGlobals()

const React = (await import('react')).default
const { act, cleanup, render } = await import('@testing-library/react')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { useLocalSliceSettingsController } = await import('./useLocalSliceSettingsController')

afterEach(() => { cleanup() })
after(() => { dom.window.close() })

function fakeProject(): ClientThreeMfProject {
  const index = bridgeLibraryThreeMfIndexSchema.parse({
    plates: [{ index: 1, name: 'Plate 1', gcodeFile: null, pickFile: null, thumbnailFile: null, plateType: 'Textured PEI Plate', nozzleSizes: ['0.4'], filaments: [], objects: [{ id: 5, name: 'Cube' }, { id: 6, name: 'Sphere' }] }],
    projectFilaments: [
      { id: 1, filamentType: 'PLA', filamentName: 'Bambu PLA Basic', color: '#10AABB', nozzleId: 0, chamberTemperature: null },
      { id: 2, filamentType: 'PLA', filamentName: 'Bambu PLA Basic', color: '#EE3333', nozzleId: 0, chamberTemperature: null }
    ],
    compatiblePrinterModels: ['X1C'],
    processProfileName: '0.20mm Standard @BBL X1C'
  })
  return { fileName: 'Widget.3mf', sizeBytes: 4096, index } as ClientThreeMfProject
}

const profile = (kind: SlicingPresetSummary['kind'], name: string, extra: Partial<SlicingPresetSummary> = {}): SlicingPresetSummary => ({
  id: `builtin:${kind}:${name}`, source: 'builtin', kind, name, printerModels: ['X1C'], ...extra
} as SlicingPresetSummary)

/** A query client pre-seeded with the anonymous catalogue, so the hook never hits the network. */
function seededClient() {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
  client.setQueryData(['public-slicer-targets'], {
    configured: true,
    defaultTargetId: 't1',
    targets: [{ id: 't1', label: 'Bambu Studio 2.1', family: 'bambustudio' as SlicerFamily, version: '02.01.00.00', slicerName: 'Bambu Studio 2.1', supportsEstimateModeMachineSwitch: false, isDefault: true, prerelease: false }]
  })
  client.setQueryData(['public-slicing-profiles', 't1'], [
    profile('machine', 'Bambu Lab X1 Carbon 0.4 nozzle', { defaultProcessProfile: '0.20mm Standard @BBL X1C' }),
    profile('process', '0.20mm Standard @BBL X1C', { layerHeight: 0.2 }),
    profile('filament', 'Bambu PLA Basic @BBL X1C', { filamentType: 'PLA' })
  ])
  return client
}

async function renderController() {
  const client = seededClient()
  let result: ReturnType<typeof useLocalSliceSettingsController> | null = null
  // Stable across renders, like the real host's project prop — an inline fakeProject() would
  // change identity every render, which no real caller does.
  const project = fakeProject()
  function Probe() {
    result = useLocalSliceSettingsController({ project, isMobileViewport: false, onClose: () => undefined })
    return null
  }
  await act(async () => {
    render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)))
  })
  // Flush the target-default + machine-profile effects.
  await act(async () => {})
  return () => result!.controller
}

test('it composes a controller from the anonymous catalogue and the project', async () => {
  const get = await renderController()
  assert.equal(get().slicerTargets.length, 1)
  assert.equal(get().selectedSlicerTargetId, 't1', 'defaults to the catalogue default target')
  assert.equal(get().file.name, 'Widget.3mf')
  assert.equal(get().projectFilaments.length, 2, 'materials come from the project index')
  assert.ok(get().printerModelOptions.includes('X1C'))
  // No printers on a browser host.
  assert.deepEqual(get().printers, [])
  assert.equal(get().targetMode, 'manualProfile')
  // The anonymous resolver is exposed on the controller so the panel's "changed vs preset" badge and
  // the process tune dialog resolve baselines without a workspace.
  assert.equal(typeof get().resolveConfig, 'function')
  // Objects must reach `plateObjects` (deduped across plates) or the editor hides the per-object
  // process gear (it gates on membership in the derived sliceObjectIds set).
  assert.deepEqual(get().plateObjects.map((object) => object.id).sort(), [5, 6])
})

test('the badge resolver is withheld until the built-in catalogue is loaded', async () => {
  // Before the built-ins arrive, the resolver cannot find a project preset's standard parent, so it
  // must NOT be exposed on the controller: firing the sidebar badge's resolve query against an empty
  // catalogue caches a wrong (low) count for its staleTime and never re-runs. The raw resolver used
  // by the tune dialogs (opened later, catalogue always ready) stays available regardless.
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
  client.setQueryData(['public-slicer-targets'], {
    configured: true,
    defaultTargetId: 't1',
    targets: [{ id: 't1', label: 'Bambu Studio 2.1', family: 'bambustudio' as SlicerFamily, version: '02.01.00.00', slicerName: 'Bambu Studio 2.1', supportsEstimateModeMachineSwitch: false, isDefault: true, prerelease: false }]
  })
  client.setQueryData(['public-slicing-profiles', 't1'], []) // catalogue not yet loaded
  let result: ReturnType<typeof useLocalSliceSettingsController> | null = null
  // Stable across renders, like the real host's project prop — an inline fakeProject() would
  // change identity every render, which no real caller does.
  const project = fakeProject()
  function Probe() {
    result = useLocalSliceSettingsController({ project, isMobileViewport: false, onClose: () => undefined })
    return null
  }
  await act(async () => { render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe))) })
  await act(async () => {})
  assert.equal(result!.controller.resolveConfig, undefined, 'no badge resolver until the catalogue loads')
  assert.equal(typeof result!.resolveProcessConfig, 'function', 'the raw resolver is always available to the dialogs')
})

test('the project process preset resolves from the catalogue', async () => {
  const get = await renderController()
  assert.ok(get().compatibleProcessProfiles.length > 0, 'a compatible process preset is offered')
  assert.ok(get().selectedProcessProfile, 'a process preset is selected')
})

test('material options derive from the compatible filament presets', async () => {
  const get = await renderController()
  assert.ok(get().materialOptions.length > 0, 'the filament preset becomes a material option')
})

test('it exposes the target printer model for the bed (separate from the controller)', async () => {
  const client = seededClient()
  let result: ReturnType<typeof useLocalSliceSettingsController> | null = null
  // Stable across renders, like the real host's project prop — an inline fakeProject() would
  // change identity every render, which no real caller does.
  const project = fakeProject()
  function Probe() {
    result = useLocalSliceSettingsController({ project, isMobileViewport: false, onClose: () => undefined })
    return null
  }
  await act(async () => { render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe))) })
  await act(async () => {})
  // The project targets X1C, so the bed the editor renders is the X1C bed — and it is NOT a field of
  // the controller, so a model switch feeds EditorView's separate prop.
  assert.equal(result!.targetPrinterModel, 'X1C')
})

test('add then remove a material moves the project filament count', async () => {
  const get = await renderController()
  assert.equal(get().projectFilaments.length, 2)
  await act(async () => { get().onAddFilament({ optionId: 'profile:pla-basic', color: '#123456', label: 'PLA' }) })
  assert.equal(get().projectFilaments.length, 3, 'a slot was appended')
  const addedId = get().projectFilaments[2]!.projectFilamentId
  await act(async () => { get().onRemoveFilament(addedId) })
  assert.equal(get().projectFilaments.length, 2, 'the added slot was removed')
})
