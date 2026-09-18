/** Preset intent must survive engine changes, partial catalogues, and delayed baseline reads. */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { LibraryFile, ThreeMfIndex, SlicingPresetSummary } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'
const dom = installJsdomGlobals()
const { renderHook, act, cleanup } = await import('@testing-library/react')
const { useProcessProfileSelection } = await import('./useProcessProfileSelection')
const { useMaterialSlots } = await import('./useMaterialSlots')
const { buildSliceMaterialOptions } = await import('../../lib/slicingPresetMatching')
const { useProjectMachineOverrides } = await import('./useProjectMachineOverrides')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const React = await import('react')
afterEach(cleanup)
after(() => dom.window.close())
const process = (id: string, name: string) => ({ id, name, kind: 'process', source: 'builtin' }) as SlicingPresetSummary
const embedded = process('project:process:0.20mm%20Standard', '0.20mm Standard')
const fine = process('fine', '0.12mm Fine')
const standard = process('standard', '0.20mm Standard')
const machine = { id: 'machine', source: 'builtin', kind: 'machine', name: 'X1C', defaultProcessProfile: standard.name } as SlicingPresetSummary
const base = { selectedPrinterModel: 'X1C', selectedNozzleDiameters: [0.4], plateType: 'textured_pei_plate', bakedProcessProfileName: embedded.name, projectPresetsReady: true, selectedMachineProfile: machine, catalogueReady: true, carryOverridesReady: true, carryOverridesOnRepick: null as Record<string, string> | null }

test('a process choice survives a project-only catalogue loading gap', () => {
  const props = { ...base, processProfiles: [embedded, fine, standard], printerCompatibleProcessProfiles: [embedded, fine, standard] }
  const view = renderHook(useProcessProfileSelection, { initialProps: props })
  act(() => { view.result.current.setProcessProfileId(fine.id); view.result.current.processProfileSelectionTouchedRef.current = true })
  view.rerender({ ...props, catalogueReady: false, processProfiles: [embedded], printerCompatibleProcessProfiles: [embedded] })
  view.rerender({ ...props })
  assert.equal(view.result.current.processProfileId, fine.id)
})

test('switching back restores a process unavailable only in the other engine', () => {
  const props = { ...base, processProfiles: [fine, standard], printerCompatibleProcessProfiles: [fine, standard] }
  const view = renderHook(useProcessProfileSelection, { initialProps: props })
  act(() => view.result.current.setProcessProfileId(fine.id))
  view.rerender({ ...props, processProfiles: [standard], printerCompatibleProcessProfiles: [standard] })
  view.rerender({ ...props })
  assert.equal(view.result.current.processProfileId, fine.id)
})

test('an engine-derived machine fallback does not replace the process choice', () => {
  const props = {
    ...base,
    catalogueKey: 'a',
    processProfiles: [fine, standard],
    printerCompatibleProcessProfiles: [fine, standard]
  }
  const view = renderHook(useProcessProfileSelection, { initialProps: props })
  act(() => view.result.current.setProcessProfileId(fine.id))
  view.rerender({
    ...props,
    catalogueKey: 'b',
    selectedPrinterModel: 'H2D',
    processProfiles: [standard],
    printerCompatibleProcessProfiles: [standard]
  })
  assert.equal(view.result.current.processProfileId, fine.id)
  assert.equal(view.result.current.selectedProcessProfile, null)
})

test('project deltas arriving after a repick are retained', () => {
  const props = { ...base, processProfiles: [embedded, standard], printerCompatibleProcessProfiles: [embedded, standard] }
  const view = renderHook(useProcessProfileSelection, { initialProps: props })
  assert.equal(view.result.current.processProfileId, embedded.id)
  view.rerender({ ...props, selectedPrinterModel: 'H2D', carryOverridesReady: false, processProfiles: [standard], printerCompatibleProcessProfiles: [standard] })
  assert.equal(view.result.current.processProfileId, embedded.id)
  view.rerender({ ...props, selectedPrinterModel: 'H2D', processProfiles: [standard], printerCompatibleProcessProfiles: [standard], carryOverridesOnRepick: { wall_loops: '5' } })
  assert.equal(view.result.current.processSettingOverrides.wall_loops, '5')
})

test('changing machine presets on the same model still applies compatibility fallback', () => {
  const props = {
    ...base,
    processProfiles: [fine, standard],
    printerCompatibleProcessProfiles: [fine, standard]
  }
  const view = renderHook(useProcessProfileSelection, { initialProps: props })
  act(() => view.result.current.setProcessProfileId(fine.id))
  view.rerender({
    ...props,
    selectedMachineProfile: { ...machine, id: 'custom-machine' },
    printerCompatibleProcessProfiles: [standard]
  })
  assert.equal(view.result.current.processProfileId, standard.id)
})

test('clearing machine overrides is not undone by changing engine', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  for (const target of ['a', 'b']) {
    client.setQueryData(['project-machine-overrides', 'file', 'v1', 'machine', target], {
      projectOverrides: { machine_max_acceleration_x: '1000' }
    })
  }
  const wrapper = ({ children }: { children: React.ReactNode }) => React.createElement(QueryClientProvider, { client }, children)
  const view = renderHook(({ target }) => {
    const [current, setCurrent] = React.useState<Record<string, string | string[]>>({})
    useProjectMachineOverrides({ sourceFileId: 'file', fileVersion: 'v1', machineProfileId: 'machine', slicerTargetId: target, current, onSeed: setCurrent })
    return { current, setCurrent }
  }, { initialProps: { target: 'a' }, wrapper })
  assert.equal(view.result.current.current.machine_max_acceleration_x, '1000')
  act(() => view.result.current.setCurrent({}))
  view.rerender({ target: 'b' })
  assert.deepEqual(view.result.current.current, {})
  view.unmount()
  client.clear()
})

test('an unavailable chosen filament does not silently revert to the file material', () => {
  const pla = { id: 'pla', name: 'Generic PLA', kind: 'filament', source: 'builtin', filamentType: 'PLA' } as SlicingPresetSummary
  const petg = { id: 'petg', name: 'Generic PETG', kind: 'filament', source: 'builtin', filamentType: 'PETG' } as SlicingPresetSummary
  const file = { id: 'f', kind: '3mf', projectFilamentChips: [] } as unknown as LibraryFile
  const index = { plates: [], projectFilaments: [{ id: 1, filamentName: pla.name, filamentType: 'PLA', color: '#111111', nozzleId: null }] } as unknown as ThreeMfIndex
  const props = { catalogueReady: true, file, bakedIndex: index, baseProjectFilaments: [{ projectFilamentId: 1, label: 'PLA', color: '#111111', nozzleId: null, usedOnSelectedPlate: true }], filamentProfiles: [pla, petg], compatibleFilamentProfiles: [pla, petg], materialOptions: buildSliceMaterialOptions([pla, petg], []), selectedMachineProfile: null }
  const view = renderHook(useMaterialSlots, { initialProps: props })
  act(() => view.result.current.handleMaterialOptionChange(1, props.materialOptions.find((option) => option.profileId === petg.id)!))
  view.rerender({ ...props, filamentProfiles: [pla], compatibleFilamentProfiles: [pla], materialOptions: buildSliceMaterialOptions([pla], []) })
  assert.equal(view.result.current.filamentMappingResult.unresolved.length, 1)
  assert.equal(view.result.current.filamentMaterialOptionIds[1], 'profile:petg')
  view.rerender(props)
  assert.equal(view.result.current.filamentMaterialOptionIds[1], 'profile:petg')
  assert.deepEqual(view.result.current.filamentMappingResult.unresolved, [])
})
