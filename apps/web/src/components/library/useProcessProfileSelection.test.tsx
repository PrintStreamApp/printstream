import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { SlicingPresetSummary } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()

const React = (await import('react')).default
const { act, cleanup, render } = await import('@testing-library/react')
const { useProcessProfileSelection } = await import('./useProcessProfileSelection')

afterEach(() => { cleanup() })
after(() => { dom.window.close() })

/**
 * The machine-switch fallback: which process preset the project lands on when the current one stops
 * being compatible. It was previously an effect buried in a 1493-line component and could only be
 * exercised by driving the whole slice dialog; extracting it is what makes these assertions possible.
 */

function processProfile(name: string, extra: Partial<SlicingPresetSummary> = {}): SlicingPresetSummary {
  return { id: `p:${name}`, source: 'builtin', kind: 'process', name, ...extra } as SlicingPresetSummary
}

function machine(defaultProcessProfile?: string): SlicingPresetSummary {
  return { id: 'm:1', source: 'builtin', kind: 'machine', name: 'X1C', defaultProcessProfile } as SlicingPresetSummary
}

/** Render the hook and report the id it settles on. */
function selectionFor(input: Parameters<typeof useProcessProfileSelection>[0]): string {
  let settled = ''
  function Probe() {
    settled = useProcessProfileSelection(input).processProfileId
    return null
  }
  render(React.createElement(Probe))
  return settled
}

const base = {
  selectedPrinterModel: 'X1C',
  selectedNozzleDiameters: [0.4],
  plateType: 'Textured PEI Plate',
  bakedProcessProfileName: null
}

test('it prefers the machine default when the layer height still matches', () => {
  const profiles = [processProfile('0.20mm Standard'), processProfile('0.28mm Draft')]
  const settled = selectionFor({
    ...base,
    processProfiles: profiles,
    printerCompatibleProcessProfiles: profiles,
    selectedMachineProfile: machine('0.20mm Standard')
  })
  assert.equal(settled, 'p:0.20mm Standard')
})

test('it falls back to 0.20mm Standard rather than whatever is first in the list', () => {
  // "Whatever is first" is the tempting shortcut and produces a surprising default; the standard
  // preset is what BambuStudio lands on.
  const profiles = [processProfile('0.28mm Draft'), processProfile('0.20mm Standard')]
  const settled = selectionFor({
    ...base,
    processProfiles: profiles,
    printerCompatibleProcessProfiles: profiles,
    selectedMachineProfile: machine(undefined)
  })
  assert.equal(settled, 'p:0.20mm Standard')
})

/**
 * The REAL load sequence: the catalogue is a slow query, so the hook first renders against an
 * empty list and picks only once the profiles land. Rendering straight into a full catalogue
 * exercises the initializer instead of the selection ladder, which is not the path users take.
 */
async function selectionAfterCatalogueLoads(
  input: Omit<Parameters<typeof useProcessProfileSelection>[0], 'processProfiles' | 'printerCompatibleProcessProfiles'>,
  profiles: SlicingPresetSummary[]
): Promise<string> {
  let settled = ''
  function Probe({ loaded }: { loaded: boolean }) {
    settled = useProcessProfileSelection({
      ...input,
      processProfiles: loaded ? profiles : [],
      printerCompatibleProcessProfiles: loaded ? profiles : []
    }).processProfileId
    return null
  }
  const view = render(React.createElement(Probe, { loaded: false }))
  view.rerender(React.createElement(Probe, { loaded: true }))
  await act(async () => {})
  return settled
}

test("the project's OWN embedded preset wins the first pick over an identically-named builtin", async () => {
  // The 3MF's preset carries the project's saved overrides (wall_loops and friends); the installed
  // preset of the same name would collapse them to its defaults. Before S2 this rung lived in the
  // workspace host's baked-defaults effect, so the public editor silently got the builtin.
  const embedded = processProfile('0.20mm Standard @BBL X1C', { id: 'project:process:0.20mm%20Standard%20%40BBL%20X1C' })
  const builtin = processProfile('0.20mm Standard @BBL X1C')
  const settled = await selectionAfterCatalogueLoads(
    { ...base, selectedMachineProfile: machine(undefined), bakedProcessProfileName: '0.20mm Standard @BBL X1C' },
    [builtin, embedded]
  )
  assert.equal(settled, embedded.id)
})

test("a baked name with no embedded preset still beats the machine default", async () => {
  const exact = processProfile('0.16mm Optimal @BBL X1C')
  const standard = processProfile('0.20mm Standard @BBL X1C')
  const settled = await selectionAfterCatalogueLoads(
    { ...base, selectedMachineProfile: machine('0.20mm Standard @BBL X1C'), bakedProcessProfileName: '0.16mm Optimal @BBL X1C' },
    [standard, exact]
  )
  assert.equal(settled, exact.id, "the project's named preset is the basis, not the machine default")
})

test('an empty catalogue settles on no selection rather than throwing', () => {
  const settled = selectionFor({
    ...base,
    processProfiles: [],
    printerCompatibleProcessProfiles: [],
    selectedMachineProfile: null
  })
  assert.equal(settled, '')
})

test('process setting overrides survive a machine-driven re-pick', async () => {
  // Changing perimeters 2 -> 3 on an A1 process and then switching to H2D must land on the H2D
  // process WITH that change still applied on top, as an override the user can see and reset --
  // not silently discarded because the preset underneath was swapped.
  const a1 = processProfile('0.20mm Standard @BBL A1')
  const h2d = processProfile('0.20mm Standard @BBL H2D')

  let selection: ReturnType<typeof useProcessProfileSelection> | null = null
  function Probe({ model, profiles }: { model: string; profiles: SlicingPresetSummary[] }) {
    selection = useProcessProfileSelection({
      ...base,
      selectedPrinterModel: model,
      processProfiles: [a1, h2d],
      printerCompatibleProcessProfiles: profiles,
      selectedMachineProfile: machine(undefined)
    })
    return null
  }

  const view = render(React.createElement(Probe, { model: 'A1', profiles: [a1] }))
  await act(async () => { selection!.setProcessProfileId(a1.id) })
  await act(async () => { selection!.setProcessSettingOverrides({ wall_loops: '3' }) })
  assert.equal(selection!.processProfileId, a1.id)

  // The machine changes: A1's preset is no longer compatible, so the fallback re-picks.
  view.rerender(React.createElement(Probe, { model: 'H2D', profiles: [h2d] }))
  await act(async () => {})

  assert.equal(selection!.processProfileId, h2d.id, 'it moved to the H2D preset')
  assert.deepEqual(selection!.processSettingOverrides, { wall_loops: '3' }, 'and kept the edit on top')
})

test("the project's baked deltas are materialized when leaving its own preset for a builtin", async () => {
  // The gap this closes: wall_loops = 4 lives in the project's BAKED config, not the override map,
  // so on A1 (project preset selected) processSettingOverrides is empty and the value is used
  // implicitly. Switching to the H2D BUILTIN overwrites every process key -- unless we surface the
  // baked delta as an override first.
  const a1 = processProfile('0.20mm Standard @BBL A1', { id: 'project:process:0.20mm%20Standard%20%40BBL%20A1' })
  const h2d = processProfile('0.20mm Standard @BBL H2D')

  let selection: ReturnType<typeof useProcessProfileSelection> | null = null
  function Probe({ model, profiles }: { model: string; profiles: SlicingPresetSummary[] }) {
    selection = useProcessProfileSelection({
      ...base,
      selectedPrinterModel: model,
      processProfiles: [a1, h2d],
      printerCompatibleProcessProfiles: profiles,
      selectedMachineProfile: machine(undefined),
      carryOverridesOnRepick: { wall_loops: '4' }
    })
    return null
  }

  const view = render(React.createElement(Probe, { model: 'A1', profiles: [a1] }))
  await act(async () => { selection!.setProcessProfileId(a1.id) })
  assert.deepEqual(selection!.processSettingOverrides, {}, 'the baked delta is implicit on the project preset, not in the map')

  view.rerender(React.createElement(Probe, { model: 'H2D', profiles: [h2d] }))
  await act(async () => {})

  assert.equal(selection!.processProfileId, h2d.id, 'it moved to the H2D builtin')
  assert.deepEqual(selection!.processSettingOverrides, { wall_loops: '4' }, 'and carried the baked delta as an override')
})

test('a session edit wins over the baked delta on the same key', async () => {
  const a1 = processProfile('0.20mm Standard @BBL A1', { id: 'project:process:0.20mm%20Standard%20%40BBL%20A1' })
  const h2d = processProfile('0.20mm Standard @BBL H2D')

  let selection: ReturnType<typeof useProcessProfileSelection> | null = null
  function Probe({ model, profiles }: { model: string; profiles: SlicingPresetSummary[] }) {
    selection = useProcessProfileSelection({
      ...base,
      selectedPrinterModel: model,
      processProfiles: [a1, h2d],
      printerCompatibleProcessProfiles: profiles,
      selectedMachineProfile: machine(undefined),
      carryOverridesOnRepick: { wall_loops: '4', sparse_infill_density: '15%' }
    })
    return null
  }

  const view = render(React.createElement(Probe, { model: 'A1', profiles: [a1] }))
  await act(async () => { selection!.setProcessProfileId(a1.id) })
  // The user edits wall loops in-session; the baked delta for that key must not clobber it.
  await act(async () => { selection!.setProcessSettingOverrides({ wall_loops: '6' }) })

  view.rerender(React.createElement(Probe, { model: 'H2D', profiles: [h2d] }))
  await act(async () => {})

  assert.deepEqual(
    selection!.processSettingOverrides,
    { wall_loops: '6', sparse_infill_density: '15%' },
    'session edit wins on the shared key; the other baked delta still carries'
  )
})

test('a builtin-to-builtin re-pick does not re-inject the carry map', async () => {
  // Only leaving the PROJECT's own preset materializes the baked deltas. Once on a builtin, the
  // deltas already live in the override map, so a further machine switch must not re-derive them
  // (which could resurrect a value the user has since reset).
  const h2dFine = processProfile('0.20mm Standard @BBL H2D')
  const x1 = processProfile('0.20mm Standard @BBL X1C')

  let selection: ReturnType<typeof useProcessProfileSelection> | null = null
  function Probe({ model, profiles }: { model: string; profiles: SlicingPresetSummary[] }) {
    selection = useProcessProfileSelection({
      ...base,
      selectedPrinterModel: model,
      processProfiles: [h2dFine, x1],
      printerCompatibleProcessProfiles: profiles,
      selectedMachineProfile: machine(undefined),
      carryOverridesOnRepick: { wall_loops: '4' }
    })
    return null
  }

  const view = render(React.createElement(Probe, { model: 'H2D', profiles: [h2dFine] }))
  await act(async () => { selection!.setProcessProfileId(h2dFine.id) })
  await act(async () => { selection!.setProcessSettingOverrides({}) })

  view.rerender(React.createElement(Probe, { model: 'X1C', profiles: [x1] }))
  await act(async () => {})

  assert.equal(selection!.processProfileId, x1.id, 'it moved to the X1C builtin')
  assert.deepEqual(selection!.processSettingOverrides, {}, 'no baked delta re-injected between builtins')
})

test('it does not latch a built-in while the project preset is still loading', () => {
  // The library host feeds this hook from TWO parallel queries — the slicer catalogue and the 3MF
  // index that carries the project's own preset. When the catalogue wins the race the list is
  // POPULATED BUT INCOMPLETE, and re-picking against it swapped a user's custom project preset for
  // a stock one permanently (the "prefer the project's preset" rung is first-pick-only, so the
  // arrival of the real preset never undoes it). An EMPTY list was always safe; a partial one is not.
  const builtins = [processProfile('0.20mm Standard'), processProfile('0.28mm Draft')]

  const duringLoad = selectionFor({
    ...base,
    processProfiles: builtins,
    printerCompatibleProcessProfiles: builtins,
    selectedMachineProfile: machine('0.20mm Standard'),
    bakedProcessProfileName: '0.20mm Standard @BBL X1C - Ryan',
    projectPresetsReady: false
  })
  assert.equal(duringLoad, '', 'nothing may be picked before the project presets have merged in')

  // Once the index lands the project's own preset is present and wins, exactly as on a cold open.
  const projectPreset = processProfile('0.20mm Standard @BBL X1C - Ryan', { id: 'project:process:0.20mm%20Standard%20%40BBL%20X1C%20-%20Ryan' })
  const complete = [...builtins, projectPreset]
  const afterLoad = selectionFor({
    ...base,
    processProfiles: complete,
    printerCompatibleProcessProfiles: complete,
    selectedMachineProfile: machine('0.20mm Standard'),
    bakedProcessProfileName: '0.20mm Standard @BBL X1C - Ryan',
    projectPresetsReady: true
  })
  assert.equal(afterLoad, projectPreset.id, "the project's own preset must win once it is available")
})
