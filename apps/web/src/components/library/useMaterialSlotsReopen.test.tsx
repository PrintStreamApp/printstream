/** Pins delayed project-name adoption without replacing an explicit material choice or color. */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { LibraryFile, SlicingPresetSummary, ThreeMfIndex } from '@printstream/shared'
import type { MaterialSlotsParams } from './useMaterialSlots'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()
const { renderHook, cleanup, act } = await import('@testing-library/react')
const { useMaterialSlots: main } = await import('./useMaterialSlots')
const { buildSliceMaterialOptions } = await import('../../lib/slicingPresetMatching')

afterEach(cleanup)
after(() => dom.window.close())

const names = ['Generic PETG HF @BBL H2D', 'Bambu PETG HF @BBL H2D 0.4 nozzle', 'Bambu PLA Basic @BBL H2D']
const colors = ['#C7372F', '#FFFFFF', '#FFFFFF']
const file = { id: 'best-shot-golf', name: 'Best Shot Golf.3mf', kind: '3mf', projectFilamentChips: [
  { label: 'Generic PETG HF', color: colors[0] },
  { label: 'Bambu PETG HF', color: colors[1] },
  { label: 'Bambu PLA Basic', color: colors[2] }
] } as unknown as LibraryFile
const machine: SlicingPresetSummary = { id: 'machine-h2d', source: 'builtin', kind: 'machine', name: 'Bambu Lab H2D 0.4 nozzle', nozzleDiameters: [0.4, 0.4], updatedAt: null }
const profile = (id: string, name: string): SlicingPresetSummary => ({ id, source: 'builtin', kind: 'filament', name, filamentType: name.includes('PETG') ? 'PETG' : 'PLA', compatiblePrinters: [machine.name], updatedAt: null })
const exact = names.map((name, i) => profile(`exact-${i + 1}`, name))
const index = { plates: [], compatiblePrinterModels: [], supportFilamentIds: [], projectFilaments: names.map((name, i) => ({
  id: i + 1, filamentName: name.split('@')[0]!.trim(), filamentPresetName: name, filamentType: i === 2 ? 'PLA' : 'PETG', color: colors[i], nozzleId: null
})) } as unknown as ThreeMfIndex
const baseProjectFilaments = names.map((_, i) => ({ projectFilamentId: i + 1, label: file.projectFilamentChips[i]!.label, color: colors[i]!, nozzleId: null, usedOnSelectedPlate: true }))
const expected = { 1: 'profile:exact-1', 2: 'profile:exact-2', 3: 'profile:exact-3' }

/** Observe the real hook across the index arriving after its shortened DTO labels. */
function reopen(hook: typeof main, earlyProfiles: SlicingPresetSummary[], lateProfiles = earlyProfiles) {
  const props: MaterialSlotsParams = { file, bakedIndex: null, baseProjectFilaments, filamentProfiles: earlyProfiles, compatibleFilamentProfiles: exact,
    materialOptions: buildSliceMaterialOptions(exact, []), selectedMachineProfile: machine }
  const view = renderHook((p) => hook(p), { initialProps: props })
  const early = { ...view.result.current.filamentMaterialOptionIds }
  view.rerender({ ...props, bakedIndex: index, filamentProfiles: lateProfiles })
  return { early, final: { ...view.result.current.filamentMaterialOptionIds }, view }
}

const subjects: Array<[string, typeof main]> = [['reopened materials', main]]

for (const [label, hook] of subjects) {
  test(`${label}: wrong nozzle of same product is correctly repointed`, () => {
    const wrong = [profile('wrong-petg-nozzle', 'Bambu PETG HF @BBL H2D 0.2 nozzle'), profile('wrong-pla-nozzle', 'Bambu PLA Basic @BBL H2D 0.2 nozzle')]
    assert.deepEqual(reopen(hook, [...wrong, ...exact]).final, expected)
  })

  test(`${label}: an inferred tuned alias must yield to final exact saved names`, () => {
    const wrong = [profile('generic-a1', 'Generic PETG HF @BBL A1'), { ...profile('custom:aa5a70e9-679b-4f2c-876b-8f549501d722', 'Bambu PETG HF - Custom'), source: 'custom' as const }, { ...profile('custom:d9fba938-bde9-49e8-aa74-7c0d101a9fd5', 'Bambu PLA Basic - Custom'), source: 'custom' as const }]
    const result = reopen(hook, [...wrong, ...exact])
    assert.deepEqual(result.final, expected)
  })

  test(`${label}: an explicit material choice before index arrival must remain user intent`, () => {
    const custom = { ...profile('explicit-custom', 'Bambu PETG HF - Custom'), source: 'custom' as const }
    const props: MaterialSlotsParams = { file, bakedIndex: null, baseProjectFilaments, filamentProfiles: [...exact, custom], compatibleFilamentProfiles: [...exact, custom],
      materialOptions: buildSliceMaterialOptions([...exact, custom], []), selectedMachineProfile: machine }
    const view = renderHook((p) => hook(p), { initialProps: props })
    const choice = props.materialOptions.find((option) => option.profileId === custom.id)
    assert.ok(choice)
    act(() => view.result.current.handleMaterialOptionChange(2, choice))
    assert.ok(view.result.current.profileEditedFilamentIds.has(2))
    view.rerender({ ...props, bakedIndex: index })
    assert.equal(view.result.current.filamentMaterialOptionIds[2], 'profile:explicit-custom')
  })

  test(`${label}: an explicitly cleared choice stays clear after the index arrives`, () => {
    const props: MaterialSlotsParams = { file, bakedIndex: null, baseProjectFilaments, filamentProfiles: exact, compatibleFilamentProfiles: exact,
      materialOptions: buildSliceMaterialOptions(exact, []), selectedMachineProfile: machine }
    const view = renderHook((p) => hook(p), { initialProps: props })
    act(() => view.result.current.handleMaterialOptionChange(2, null))
    view.rerender({ ...props, bakedIndex: index })
    assert.equal(view.result.current.filamentMaterialOptionIds[2], '')
  })

  test(`${label}: an unavailable explicit custom pick stays unresolved rather than substituted`, () => {
    const custom = { ...profile('explicit-unavailable', 'Bambu PETG HF - User choice'), source: 'custom' as const }
    const props: MaterialSlotsParams = { file, bakedIndex: null, baseProjectFilaments, filamentProfiles: [...exact, custom], compatibleFilamentProfiles: [...exact, custom],
      materialOptions: buildSliceMaterialOptions([...exact, custom], []), selectedMachineProfile: machine }
    const view = renderHook((p) => hook(p), { initialProps: props })
    const choice = props.materialOptions.find((option) => option.profileId === custom.id)
    assert.ok(choice)
    act(() => view.result.current.handleMaterialOptionChange(2, choice))
    view.rerender({ ...props, bakedIndex: index, compatibleFilamentProfiles: exact, materialOptions: buildSliceMaterialOptions(exact, []) })
    assert.equal(view.result.current.filamentMaterialOptionIds[2], 'profile:explicit-unavailable')
  })

  test(`${label}: adopting accurate profile names does not change file or user colors`, () => {
    const custom = { ...profile('inferred-custom', 'Bambu PETG HF - Custom'), source: 'custom' as const }
    const props: MaterialSlotsParams = { file, bakedIndex: null, baseProjectFilaments, filamentProfiles: [custom, ...exact], compatibleFilamentProfiles: exact,
      materialOptions: buildSliceMaterialOptions(exact, []), selectedMachineProfile: machine }
    const view = renderHook((p) => hook(p), { initialProps: props })
    act(() => view.result.current.setFilamentColors((old) => ({ ...old, 2: '#ABCDEF' })))
    const before = JSON.stringify(view.result.current.filamentColors)
    view.rerender({ ...props, bakedIndex: index })
    assert.equal(JSON.stringify(view.result.current.filamentColors), before)
    assert.deepEqual(view.result.current.desiredFilaments?.map((filament) => filament.color), ['#c7372f', '#abcdef', '#ffffff'])
  })

  test(`${label}: inferred entries disappearing during catalogue replacement must yield to final exact names`, () => {
    const wrong = [profile('old-petg', 'Bambu PETG HF @BBL X1C'), profile('old-pla', 'Bambu PLA Basic @BBL X1C')]
    const result = reopen(hook, [...wrong, ...exact], exact)
    assert.deepEqual(result.final, expected)
  })

  test(`${label}: an index preceding compatible profiles does not consume pending guesses`, () => {
    const wrong = [profile('wrong-petg', 'Bambu PETG HF - Custom'), profile('wrong-pla', 'Bambu PLA Basic - Custom')]
    const props: MaterialSlotsParams = { file, bakedIndex: null, baseProjectFilaments, filamentProfiles: [...wrong, ...exact], compatibleFilamentProfiles: [],
      materialOptions: [], selectedMachineProfile: machine, catalogueReady: true }
    const view = renderHook((p) => hook(p), { initialProps: props })
    view.rerender({ ...props, bakedIndex: index })
    assert.equal(view.result.current.filamentMaterialOptionIds[2], 'profile:wrong-petg')
    view.rerender({ ...props, bakedIndex: index, compatibleFilamentProfiles: exact, materialOptions: buildSliceMaterialOptions(exact, []) })
    assert.deepEqual(view.result.current.filamentMaterialOptionIds, expected)
  })

  test(`${label}: partial catalogues settle only exact names, not weak PETG fallbacks`, () => {
    const wrong = [profile('wrong-petg', 'Bambu PETG HF - Custom'), profile('wrong-pla', 'Bambu PLA Basic - Custom')]
    const first = [exact[0]!]
    const props: MaterialSlotsParams = { file, bakedIndex: null, baseProjectFilaments, filamentProfiles: [...wrong, ...exact], compatibleFilamentProfiles: first,
      materialOptions: buildSliceMaterialOptions(first, []), selectedMachineProfile: machine, catalogueReady: true }
    const view = renderHook((p) => hook(p), { initialProps: props })
    view.rerender({ ...props, bakedIndex: index })
    assert.equal(view.result.current.filamentMaterialOptionIds[2], 'profile:wrong-petg')
    const firstTwo = exact.slice(0, 2)
    view.rerender({ ...props, bakedIndex: index, compatibleFilamentProfiles: firstTwo, materialOptions: buildSliceMaterialOptions(firstTwo, []) })
    assert.equal(view.result.current.filamentMaterialOptionIds[2], expected[2])
    assert.equal(view.result.current.filamentMaterialOptionIds[3], 'profile:wrong-pla')
    view.rerender({ ...props, bakedIndex: index, compatibleFilamentProfiles: exact, materialOptions: buildSliceMaterialOptions(exact, []) })
    assert.deepEqual(view.result.current.filamentMaterialOptionIds, expected)
  })

  test(`${label}: add and reorder before index arrival preserve row ownership and the added choice`, () => {
    const wrong = [profile('wrong-petg', 'Bambu PETG HF - Custom'), profile('wrong-pla', 'Bambu PLA Basic - Custom')]
    const props: MaterialSlotsParams = { file, bakedIndex: null, baseProjectFilaments, filamentProfiles: [...wrong, ...exact], compatibleFilamentProfiles: exact,
      materialOptions: buildSliceMaterialOptions(exact, []), selectedMachineProfile: machine }
    const view = renderHook((p) => hook(p), { initialProps: props })
    act(() => view.result.current.handleAddFilament({ optionId: 'profile:explicit-added', color: '#123456', label: 'PETG' }))
    act(() => view.result.current.handleReorderFilament(2, 0))
    view.rerender({ ...props, bakedIndex: index })
    assert.deepEqual(view.result.current.projectFilaments.map((row) => row.projectFilamentId), [3, 1, 2, 4])
    assert.deepEqual(view.result.current.filamentMaterialOptionIds, { ...expected, 4: 'profile:explicit-added' })
    assert.equal(view.result.current.filamentColors[4], '#123456')
  })

  test(`${label}: explicitly confirming the same inferred custom option makes it user intent`, () => {
    const custom = { ...profile('explicit-inference', 'Bambu PETG HF - Custom'), source: 'custom' as const }
    const all = [custom, ...exact]
    const props: MaterialSlotsParams = { file, bakedIndex: null, baseProjectFilaments, filamentProfiles: all, compatibleFilamentProfiles: all,
      materialOptions: buildSliceMaterialOptions(all, []), selectedMachineProfile: machine }
    const view = renderHook((p) => hook(p), { initialProps: props })
    assert.equal(view.result.current.filamentMaterialOptionIds[2], 'profile:explicit-inference')
    const choice = props.materialOptions.find((option) => option.profileId === custom.id)
    assert.ok(choice)
    act(() => view.result.current.handleMaterialOptionChange(2, choice))
    view.rerender({ ...props, bakedIndex: index })
    assert.equal(view.result.current.filamentMaterialOptionIds[2], 'profile:explicit-inference')
  })
}
