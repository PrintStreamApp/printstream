/**
 * The machine-target hook: the INTENT half. The ladders themselves are pinned against the pure
 * cascade in `lib/machineTargetResolution.test.ts`; what is only observable here is that a user
 * pick sticks across re-renders and late-arriving inputs, that an engine change clears it, and that
 * undo restores it.
 *
 * Written first as a characterization net for the pre-S2 effect web (see the audit's S2 entry).
 * Two assertions it originally recorded were bugs — a 0.6-nozzle project seeding 0.4, and a plate
 * the new machine could not offer being swapped silently — and both are now flipped to the fixed
 * behaviour, called out in place.
 */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { LibraryFile, Printer, SlicingPresetSummary, ThreeMfIndex } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()

const { renderHook, act, cleanup } = await import('@testing-library/react')
const { useMachineTarget } = await import('./useMachineTarget')

afterEach(() => { cleanup() })
after(() => { dom.window.close() })

function libraryFile(extra: Partial<LibraryFile> = {}): LibraryFile {
  return { id: 'f1', name: 'Widget.3mf', kind: '3mf', compatiblePrinterModels: [], plateTypeChips: [], nozzleSizeChips: [], ...extra } as unknown as LibraryFile
}

function index(extra: Partial<ThreeMfIndex> = {}): ThreeMfIndex {
  return { plates: [], projectFilaments: [], compatiblePrinterModels: [], supportFilamentIds: [], printerProfileName: null, processProfileName: null, ...extra } as unknown as ThreeMfIndex
}

function plate(extra: Record<string, unknown> = {}) {
  return { index: 1, name: null, hasThumbnail: false, plateType: null, nozzleSizes: [], filaments: [], objects: [], ...extra }
}

function machine(name: string, extra: Partial<SlicingPresetSummary> = {}): SlicingPresetSummary {
  return { id: `m:${name}`, source: 'builtin', kind: 'machine', name, ...extra } as SlicingPresetSummary
}

const H2D_04 = machine('Bambu Lab H2D 0.4 nozzle', { printerModels: ['H2D'], nozzleDiameters: [0.4] })
const H2D_06 = machine('Bambu Lab H2D 0.6 nozzle', { printerModels: ['H2D'], nozzleDiameters: [0.6] })
const A1_04 = machine('Bambu Lab A1 0.4 nozzle', { printerModels: ['A1'], nozzleDiameters: [0.4] })

type Params = Parameters<typeof useMachineTarget>[0]

function baseParams(extra: Partial<Params> = {}): Params {
  return {
    file: libraryFile(),
    bakedIndex: null,
    machineProfiles: [],
    processProfiles: [],
    projectResolved: false,
    catalogueResolved: false,
    ...extra
  }
}

function renderTarget(params: Params) {
  return renderHook((p: Params) => useMachineTarget(p), { initialProps: params })
}

/** Both async inputs settled — the normal steady state. */
const SETTLED = { projectResolved: true, catalogueResolved: true }

// ---- seeding --------------------------------------------------------------------------------

test('the model stays unresolved until the project says otherwise — nothing guesses', () => {
  const { result } = renderTarget(baseParams({ machineProfiles: [H2D_04, A1_04] }))
  assert.equal(result.current.manualPrinterModel, 'unknown', '"unknown" is the not-known value (issue #66)')
  assert.equal(result.current.origins.printerModel, 'unseeded')
  assert.equal(result.current.resolved, false)
})

test("a late-arriving index adopts the project's own model without waiting for the catalogue", () => {
  const { result, rerender } = renderTarget(baseParams())
  rerender(baseParams({ bakedIndex: index({ compatiblePrinterModels: ['H2D'] }), projectResolved: true }))
  assert.equal(result.current.manualPrinterModel, 'H2D')
})

test('a model the user picked survives the index arriving afterwards', () => {
  const params = baseParams({ machineProfiles: [H2D_04, A1_04], ...SETTLED })
  const { result, rerender } = renderTarget(params)
  act(() => { result.current.selectPrinterModel('A1') })
  rerender(baseParams({ machineProfiles: [H2D_04, A1_04], bakedIndex: index({ compatiblePrinterModels: ['H2D'] }), ...SETTLED }))
  assert.equal(result.current.manualPrinterModel, 'A1', 'the intent is what makes a deliberate pick stick')
  assert.equal(result.current.origins.printerModel, 'user')
})

test('the machine profile follows the model with no writer of its own', () => {
  const params = baseParams({ machineProfiles: [H2D_04, A1_04], bakedIndex: index({ compatiblePrinterModels: ['H2D'] }), ...SETTLED })
  const { result } = renderTarget(params)
  assert.equal(result.current.printerProfileId, H2D_04.id)
  act(() => { result.current.selectPrinterModel('A1') })
  assert.equal(result.current.printerProfileId, A1_04.id)
})

test('FIXED (was the min-of-union seed): a 0.6-nozzle project opens on 0.6', () => {
  // The pre-S2 seed took the ascending minimum of a union that always contained a hardcoded 0.4, so
  // this project opened on a 0.4 nozzle that nothing offered — leaving no compatible machine
  // profile and a Slice button blocked as "printer profile doesn't match the target printer".
  const { result } = renderTarget(baseParams({
    file: libraryFile({ nozzleSizeChips: ['0.6'] }),
    machineProfiles: [H2D_06],
    bakedIndex: index({ compatiblePrinterModels: ['H2D'], plates: [plate({ nozzleSizes: ['0.6'] })] }) as ThreeMfIndex,
    ...SETTLED
  }))
  assert.equal(result.current.nozzleDiameter, '0.6')
  assert.equal(result.current.printerProfileId, H2D_06.id)
  assert.equal(result.current.compatibleMachineProfiles.length, 1)
})

test("the project's own plate seeds the selection", () => {
  const { result } = renderTarget(baseParams({
    machineProfiles: [H2D_04],
    bakedIndex: index({ compatiblePrinterModels: ['H2D'], plates: [plate({ plateType: 'cool_plate' })] }) as ThreeMfIndex,
    ...SETTLED
  }))
  assert.equal(result.current.plateType, 'cool_plate')
})

// ---- user picks vs reconciliation -------------------------------------------------------------

test('a plate the user picked survives a value-form change in the options list', () => {
  const labelForm = machine('Bambu Lab H2D 0.4 nozzle', { printerModels: ['H2D'], nozzleDiameters: [0.4], plateTypes: ['High Temp Plate'] })
  const withLabelForm = baseParams({ machineProfiles: [labelForm], bakedIndex: index({ compatiblePrinterModels: ['H2D'] }), ...SETTLED })
  const { result, rerender } = renderTarget(withLabelForm)
  act(() => { result.current.handlePlateTypeChange('High Temp Plate') })
  assert.equal(result.current.plateType, 'High Temp Plate')

  rerender(baseParams({ machineProfiles: [H2D_04], bakedIndex: index({ compatiblePrinterModels: ['H2D'] }), ...SETTLED }))
  assert.equal(result.current.plateType, 'high_temp_plate', 'same plate, re-identified by label rather than dropped')
  assert.deepEqual(result.current.conflicts, [], 'nothing was actually lost, so nothing is reported')
})

test('FIXED (E9): a plate the new machine cannot offer is reported, and comes back if it returns', () => {
  const withCustom = machine('Bambu Lab H2D 0.4 nozzle', { printerModels: ['H2D'], nozzleDiameters: [0.4], plateTypes: ['Garolite Plate'] })
  const offering = baseParams({ machineProfiles: [withCustom], bakedIndex: index({ compatiblePrinterModels: ['H2D'] }), ...SETTLED })
  const { result, rerender } = renderTarget(offering)
  act(() => { result.current.handlePlateTypeChange('Garolite Plate') })
  assert.equal(result.current.plateType, 'Garolite Plate')

  rerender(baseParams({ machineProfiles: [H2D_04], bakedIndex: index({ compatiblePrinterModels: ['H2D'] }), ...SETTLED }))
  assert.equal(result.current.plateType, 'textured_pei_plate', 'an unusable plate is not left selected')
  assert.deepEqual(result.current.conflicts, [{ field: 'plateType', requested: 'Garolite Plate', applied: 'textured_pei_plate' }])

  rerender(offering)
  assert.equal(result.current.plateType, 'Garolite Plate', 'the intent was never overwritten, so the choice returns')
})

test('an updater form of a setter is applied to the RESOLVED value, not to the sparse intent', () => {
  const params = baseParams({ machineProfiles: [H2D_04, H2D_06], bakedIndex: index({ compatiblePrinterModels: ['H2D'] }), ...SETTLED })
  const { result } = renderTarget(params)
  assert.equal(result.current.nozzleDiameter, '0.4', 'nothing picked yet: derived')
  act(() => { result.current.setNozzleDiameter((current) => (current === '0.4' ? '0.6' : current)) })
  assert.equal(result.current.nozzleDiameter, '0.6')
})

// ---- printer target ---------------------------------------------------------------------------

test('selecting a printer sets the mode and the target in one gesture', () => {
  const farm = { id: 'p1', name: 'Farm 06', model: 'H2D', currentNozzleDiameters: [], currentPlateType: null } as unknown as Printer
  const params = baseParams({ machineProfiles: [A1_04, H2D_04], printers: [farm], bakedIndex: index(), ...SETTLED })
  const { result } = renderTarget(params)
  assert.equal(result.current.targetMode, 'manualProfile')
  act(() => { result.current.selectPrinter(farm) })
  assert.equal(result.current.targetMode, 'realPrinter')
  assert.equal(result.current.selectedPrinterModel, 'H2D')
  assert.equal(result.current.printerProfileId, H2D_04.id)
})

test('a locked preferred printer pins the target without an effect racing the picker', () => {
  const locked = { id: 'locked', name: 'Farm 06', model: 'H2D', currentNozzleDiameters: [], currentPlateType: null } as unknown as Printer
  const { result } = renderTarget(baseParams({
    machineProfiles: [A1_04, H2D_04],
    printers: [locked],
    lockedPreferredPrinter: locked,
    bakedIndex: index(),
    ...SETTLED
  }))
  assert.equal(result.current.targetMode, 'realPrinter')
  assert.equal(result.current.printerId, 'locked')
})

// ---- reset + snapshot ---------------------------------------------------------------------------

test('an engine-target change clears every pick, not just some of them', () => {
  // Pre-S2 this reset the model's touched flag and the process's, but never the plate's.
  const params = baseParams({ machineProfiles: [H2D_04, A1_04], bakedIndex: index({ compatiblePrinterModels: ['H2D'] }), ...SETTLED, resetToken: 'engine-1' })
  const { result, rerender } = renderTarget(params)
  act(() => { result.current.selectPrinterModel('A1') })
  act(() => { result.current.handlePlateTypeChange('cool_plate') })
  assert.equal(result.current.manualPrinterModel, 'A1')
  assert.equal(result.current.plateType, 'cool_plate')

  rerender({ ...params, resetToken: 'engine-2' })
  assert.equal(result.current.manualPrinterModel, 'H2D', 'back to the project')
  assert.equal(result.current.plateType, 'textured_pei_plate')
})

test('the snapshot round-trips the picks; everything else re-derives on restore', () => {
  const params = baseParams({ machineProfiles: [H2D_04, A1_04], bakedIndex: index({ compatiblePrinterModels: ['H2D'] }), ...SETTLED })
  const { result } = renderTarget(params)
  act(() => { result.current.selectPrinterModel('A1') })
  const snapshot = result.current.machineSnapshot
  assert.deepEqual(snapshot.machineTargetIntent, { printerModel: 'A1' }, 'only the pick is recorded')

  act(() => { result.current.selectPrinterModel('H2D') })
  assert.equal(result.current.printerProfileId, H2D_04.id)
  act(() => { result.current.restoreMachineSnapshot(snapshot) })
  assert.equal(result.current.manualPrinterModel, 'A1')
  assert.equal(result.current.printerProfileId, A1_04.id, 'the derived machine profile follows the restored pick')
})
