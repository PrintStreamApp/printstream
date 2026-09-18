/** Regression coverage for catalogue transitions without discarding session material edits. */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { LibraryFile, ThreeMfIndex, SlicingPresetSummary } from '@printstream/shared'

const dom = installJsdomGlobals()
const { renderHook, act, cleanup } = await import('@testing-library/react')
const { useMemo, useEffect, useRef } = await import('react')
const { useMaterialSlots } = await import('./useMaterialSlots')
const { useHeldSnapshot } = await import('./useHeldSnapshot')
const { buildSliceMaterialOptions } = await import('../../lib/slicingPresetMatching')

afterEach(cleanup)
after(() => dom.window.close())

const profiles = [
  { id: 'pla', source: 'builtin', kind: 'filament', name: 'Generic PLA', filamentType: 'PLA' },
  { id: 'petg', source: 'builtin', kind: 'filament', name: 'Generic PETG', filamentType: 'PETG' }
] as SlicingPresetSummary[]
const empty: SlicingPresetSummary[] = []
const file = { id: 'f', name: 'project.3mf', kind: '3mf', projectFilamentChips: [] } as unknown as LibraryFile
const bakedIndex = { plates: [], projectFilaments: [{ id: 1, filamentName: 'Generic PLA', filamentType: 'PLA', color: '#111111', nozzleId: null }] } as unknown as ThreeMfIndex
const baseProjectFilaments = [{ projectFilamentId: 1, label: 'PLA', color: '#111111', nozzleId: null, usedOnSelectedPlate: true }]

/** Exercise the held catalogue and the host's target-scoped initialization together. */
function useProbe(p: { target: string; live: SlicingPresetSummary[] }) {
  const held = useHeldSnapshot(p.live, { hold: true, ready: p.live.length > 0, token: 0, scope: p.target })
  const materialOptions = useMemo(() => buildSliceMaterialOptions(held, []), [held])
  const catalogueReady = p.live.length > 0
  const slots = useMaterialSlots({
    catalogueReady,
    file,
    bakedIndex,
    baseProjectFilaments,
    filamentProfiles: held,
    compatibleFilamentProfiles: held,
    materialOptions,
    selectedMachineProfile: null
  })
  const { applyBakedMaterialDefaults } = slots
  const applied = useRef(false)
  useEffect(() => { applied.current = false }, [p.target])
  useEffect(() => {
    if (applied.current || !catalogueReady) return
    applyBakedMaterialDefaults()
    applied.current = true
  }, [applyBakedMaterialDefaults, catalogueReady, p.target])
  return slots
}

test('an uncached version switch preserves an added material through the loading gap', () => {
  const props = { target: 'a', live: profiles }
  const view = renderHook(useProbe, { initialProps: props })
  act(() => view.result.current.handleAddFilament({ optionId: 'profile:petg', color: '#ff0000', label: 'PETG' }))
  view.rerender({ ...props, target: 'b', live: empty })
  assert.equal(view.result.current.filamentMaterialOptionIds[2], 'profile:petg')
  view.rerender({ ...props, target: 'b' })
  assert.equal(view.result.current.filamentMaterialOptionIds[2], 'profile:petg')
  assert.deepEqual(view.result.current.filamentMappingResult.unresolved, [])
})

test('a cached version switch preserves edited base material preset and colour', () => {
  const props = { target: 'a', live: profiles }
  const view = renderHook(useProbe, { initialProps: props })
  act(() => {
    view.result.current.handleMaterialOptionChange(1, buildSliceMaterialOptions(profiles, [])[1]!)
    view.result.current.setFilamentColors({ 1: '#ff0000' })
  })
  view.rerender({ ...props, target: 'b' })
  assert.equal(view.result.current.filamentColors[1], '#ff0000')
  assert.equal(view.result.current.filamentMaterialOptionIds[1], 'profile:petg')
})

test('a loaded catalogue still rejects a removed session preset', () => {
  const props = { target: 'a', live: profiles }
  const view = renderHook(useProbe, { initialProps: props })
  act(() => view.result.current.handleAddFilament({ optionId: 'profile:petg', color: '#ff0000', label: 'PETG' }))
  view.rerender({ ...props, target: 'b', live: empty })
  view.rerender({ ...props, target: 'b', live: [profiles[0]!] })
  assert.equal(view.result.current.filamentMaterialOptionIds[2], 'profile:petg')
  assert.equal(view.result.current.filamentMappingResult.unresolved[0]?.projectFilamentId, 2)
})
