/**
 * The machine-target cascade (see machineTargetResolution.ts). Pins the ladders, the two bugs S2
 * fixes (the min-of-union nozzle seed and E9's silent plate swap), and the property the whole
 * design rests on: a user pick is honoured whenever the inputs can represent it, and REPORTED —
 * never quietly replaced — when they cannot.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LibraryFile, Printer, SlicingPresetSummary, SlicingTargetDescriptor, ThreeMfIndex } from '@printstream/shared'
import {
  resolveMachineTarget,
  resolveProjectNozzleDiameter,
  resolveSlicerTargetId,
  type MachineTargetInputs,
  type MachineTargetIntent
} from './machineTargetResolution'

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

function printer(extra: Partial<Printer> = {}): Printer {
  return { id: 'p1', name: 'Farm 06', model: 'H2D', currentNozzleDiameters: [], currentPlateType: null, ...extra } as unknown as Printer
}

const H2D_04 = machine('Bambu Lab H2D 0.4 nozzle', { printerModels: ['H2D'], nozzleDiameters: [0.4] })
const H2D_06 = machine('Bambu Lab H2D 0.6 nozzle', { printerModels: ['H2D'], nozzleDiameters: [0.6] })
const A1_04 = machine('Bambu Lab A1 0.4 nozzle', { printerModels: ['A1'], nozzleDiameters: [0.4] })

function inputs(extra: Partial<MachineTargetInputs> = {}): MachineTargetInputs {
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

function resolveWith(extra: Partial<MachineTargetInputs>, intent: MachineTargetIntent = {}) {
  return resolveMachineTarget(inputs(extra), intent)
}

/** Both async inputs settled — the normal steady state. */
function settled(extra: Partial<MachineTargetInputs> = {}): Partial<MachineTargetInputs> {
  return { projectResolved: true, catalogueResolved: true, ...extra }
}

// ---- engine target --------------------------------------------------------------------------

function target(id: string, extra: Partial<SlicingTargetDescriptor> = {}): SlicingTargetDescriptor {
  return { id, label: id, family: 'bambustudio', version: '2.0', slicerName: 'bs', supportsEstimateModeMachineSwitch: false, isDefault: false, prerelease: false, ...extra } as SlicingTargetDescriptor
}

test('the engine target keeps the user pick, and never falls back onto a prerelease', () => {
  const targets = [target('beta', { prerelease: true }), target('stable'), target('older')]
  assert.equal(resolveSlicerTargetId(targets, null, 'beta'), 'beta', 'an explicit beta pick is honoured')
  assert.equal(resolveSlicerTargetId(targets, null, 'gone'), 'stable', 'a pick that no longer exists falls to the first STABLE target')
  assert.equal(resolveSlicerTargetId(targets, 'older', undefined), 'older', 'the declared default wins over list order')
  assert.equal(resolveSlicerTargetId([], null, 'x'), '')
})

// ---- model ----------------------------------------------------------------------------------

test('the model stays unresolved until both inputs settle, then defaults to the first machine', () => {
  const withCatalogue = { machineProfiles: [H2D_04, A1_04], bakedIndex: index() }
  assert.equal(resolveWith({ ...withCatalogue, projectResolved: true }).manualPrinterModel, 'unknown')
  assert.equal(resolveWith({ ...withCatalogue, ...settled() }).manualPrinterModel, 'A1')
  assert.equal(resolveWith({ ...withCatalogue, ...settled() }).origins.printerModel, 'catalogue')
})

test("the project's own model wins over the catalogue default and needs no catalogue at all", () => {
  const result = resolveWith({ machineProfiles: [A1_04, H2D_04], bakedIndex: index({ compatiblePrinterModels: ['H2D'] }), projectResolved: true })
  assert.equal(result.manualPrinterModel, 'H2D')
  assert.equal(result.origins.printerModel, 'project')
})

test('a user pick beats the project, and a pick the catalogue cannot offer is reported', () => {
  const withBoth = { machineProfiles: [A1_04, H2D_04], bakedIndex: index({ compatiblePrinterModels: ['H2D'] }), ...settled() }
  const kept = resolveWith(withBoth, { printerModel: 'A1' })
  assert.equal(kept.manualPrinterModel, 'A1')
  assert.equal(kept.origins.printerModel, 'user')
  assert.deepEqual(kept.conflicts, [])

  const dropped = resolveWith({ machineProfiles: [H2D_04], bakedIndex: index({ compatiblePrinterModels: ['H2D'] }), ...settled() }, { printerModel: 'A1' })
  assert.equal(dropped.manualPrinterModel, 'H2D')
  assert.deepEqual(dropped.conflicts, [{ field: 'printerModel', requested: 'A1', applied: 'H2D' }])
})

// ---- nozzle ---------------------------------------------------------------------------------

test("the nozzle seeds from the PROJECT, not from the smallest option (the pre-S2 bug)", () => {
  // Before S2 this landed on 0.4 — a value nothing in this scenario offers — and then no machine
  // profile matched it, so the submit gate reported an incompatible printer profile on a project
  // that was perfectly fine.
  const result = resolveWith({
    file: libraryFile({ nozzleSizeChips: ['0.6'] }),
    machineProfiles: [H2D_06],
    bakedIndex: index({ compatiblePrinterModels: ['H2D'], plates: [plate({ nozzleSizes: ['0.6'] })] }) as ThreeMfIndex,
    ...settled()
  })
  assert.equal(result.nozzleDiameter, '0.6')
  assert.equal(result.origins.nozzleDiameter, 'project')
  assert.equal(result.printerProfileId, H2D_06.id, 'and the machine profile follows it instead of being stranded')
  assert.deepEqual(result.nozzleDiameterOptions, ['0.6'], 'no phantom 0.4 that nothing offers')
})

test('a dual-nozzle project seeds the smallest of ITS OWN diameters', () => {
  assert.equal(
    resolveProjectNozzleDiameter(libraryFile(), index({ plates: [plate({ nozzleSizes: ['0.6', '0.4'] })] }) as ThreeMfIndex),
    '0.4'
  )
  assert.equal(resolveProjectNozzleDiameter(libraryFile(), null), null, 'a project that says nothing seeds nothing')
})

test('a user nozzle pick is kept while offered and reported when it is not', () => {
  const both = { file: libraryFile(), machineProfiles: [H2D_04, H2D_06], bakedIndex: index({ compatiblePrinterModels: ['H2D'] }), ...settled() }
  assert.equal(resolveWith(both, { nozzleDiameter: '0.6' }).nozzleDiameter, '0.6')

  const narrowed = resolveWith({ ...both, machineProfiles: [H2D_04] }, { nozzleDiameter: '0.6' })
  assert.equal(narrowed.nozzleDiameter, '0.4')
  assert.deepEqual(narrowed.conflicts, [{ field: 'nozzleDiameter', requested: '0.6', applied: '0.4' }])
})

test('a printer with no project hint contributes its own loaded nozzle', () => {
  const withPrinter = printer({ currentNozzleDiameters: [{ diameter: '0.6' }] as Printer['currentNozzleDiameters'] })
  const result = resolveWith(
    { machineProfiles: [H2D_04, H2D_06], printers: [withPrinter], bakedIndex: index(), ...settled() },
    { printerId: withPrinter.id }
  )
  assert.equal(result.nozzleDiameter, '0.6')
  assert.equal(result.origins.nozzleDiameter, 'printer')
})

// ---- machine profile ------------------------------------------------------------------------

test('a real printer target matches its own machine profile', () => {
  const target06 = printer({ name: 'Bambu Lab H2D 0.6 nozzle', currentNozzleDiameters: [{ diameter: '0.6' }] as Printer['currentNozzleDiameters'] })
  const result = resolveWith(
    { machineProfiles: [A1_04, H2D_04, H2D_06], printers: [target06], bakedIndex: index(), ...settled() },
    { printerId: target06.id }
  )
  assert.equal(result.targetMode, 'realPrinter')
  assert.equal(result.printerProfileId, H2D_06.id)
  assert.equal(result.origins.printerProfileId, 'printer')
})

test("the project's named machine profile is preferred over list order", () => {
  const result = resolveWith({
    machineProfiles: [H2D_04, H2D_06],
    bakedIndex: index({ compatiblePrinterModels: ['H2D'], printerProfileName: 'Bambu Lab H2D 0.6 nozzle', plates: [plate({ nozzleSizes: ['0.6'] })] }) as ThreeMfIndex,
    ...settled()
  })
  assert.equal(result.printerProfileId, H2D_06.id)
  assert.equal(result.origins.printerProfileId, 'project')
})

test('no compatible machine profile resolves to no selection rather than an incompatible one', () => {
  // '' is what `resolveSliceDisabledReason` turns into "No matching printer profile is installed
  // for this printer and nozzle" — the honest message. Before S2 the stale id survived here and the
  // user was told their profile "doesn't match the target printer" instead.
  const result = resolveWith({ machineProfiles: [A1_04], bakedIndex: index({ compatiblePrinterModels: ['H2D'] }), ...settled() })
  assert.equal(result.printerProfileId, '')
  assert.equal(result.selectedMachineProfile, null)
  assert.equal(result.origins.printerProfileId, 'unseeded')
})

// ---- plate ----------------------------------------------------------------------------------

test("the project's own plate seeds, and the printer's loaded plate only fills a project that has none", () => {
  const loaded = printer({ currentPlateType: 'High Temp Plate' })
  const withProjectPlate = resolveWith(
    {
      machineProfiles: [H2D_04],
      printers: [loaded],
      bakedIndex: index({ compatiblePrinterModels: ['H2D'], plates: [plate({ plateType: 'cool_plate' })] }) as ThreeMfIndex,
      ...settled()
    },
    { printerId: loaded.id }
  )
  assert.equal(withProjectPlate.plateType, 'cool_plate', "an existing project's own plate wins")

  const withoutProjectPlate = resolveWith(
    { machineProfiles: [H2D_04], printers: [loaded], bakedIndex: index({ compatiblePrinterModels: ['H2D'] }), ...settled() },
    { printerId: loaded.id }
  )
  assert.equal(withoutProjectPlate.plateType, 'high_temp_plate', "a new project inherits the printer's loaded plate")
  assert.equal(withoutProjectPlate.origins.plateType, 'printer')
})

test('a user plate pick survives a value-form change, because every rung matches by LABEL', () => {
  const labelForm = machine('Bambu Lab H2D 0.4 nozzle', { printerModels: ['H2D'], nozzleDiameters: [0.4], plateTypes: ['High Temp Plate'] })
  const asLabel = resolveWith({ machineProfiles: [labelForm], bakedIndex: index({ compatiblePrinterModels: ['H2D'] }), ...settled() }, { plateType: 'High Temp Plate' })
  assert.equal(asLabel.plateType, 'High Temp Plate')

  const asCode = resolveWith({ machineProfiles: [H2D_04], bakedIndex: index({ compatiblePrinterModels: ['H2D'] }), ...settled() }, { plateType: 'High Temp Plate' })
  assert.equal(asCode.plateType, 'high_temp_plate', 'same plate, re-identified rather than dropped')
  assert.deepEqual(asCode.conflicts, [], 'and no conflict, because nothing was actually lost')
})

test('E9 FIXED: an unavailable plate is reported, and the intent survives to be restored later', () => {
  const withCustom = machine('Bambu Lab H2D 0.4 nozzle', { printerModels: ['H2D'], nozzleDiameters: [0.4], plateTypes: ['Garolite Plate'] })
  const intent: MachineTargetIntent = { plateType: 'Garolite Plate' }
  const baked = index({ compatiblePrinterModels: ['H2D'] })

  const offered = resolveWith({ machineProfiles: [withCustom], bakedIndex: baked, ...settled() }, intent)
  assert.equal(offered.plateType, 'Garolite Plate')

  const dropped = resolveWith({ machineProfiles: [H2D_04], bakedIndex: baked, ...settled() }, intent)
  assert.equal(dropped.plateType, 'textured_pei_plate')
  assert.deepEqual(dropped.conflicts, [{ field: 'plateType', requested: 'Garolite Plate', applied: 'textured_pei_plate' }])

  // The same intent against the original machine again: the choice comes back, because the drop
  // never wrote to state. That is the whole reason the intent is separate from the resolved value.
  const restored = resolveWith({ machineProfiles: [withCustom], bakedIndex: baked, ...settled() }, intent)
  assert.equal(restored.plateType, 'Garolite Plate')
})

// ---- printer target -------------------------------------------------------------------------

test('a locked preferred printer overrides the intent rather than racing it', () => {
  const locked = printer({ id: 'locked', model: 'H2D' })
  const other = printer({ id: 'other', model: 'A1' })
  const result = resolveWith(
    { machineProfiles: [A1_04, H2D_04], printers: [locked, other], lockedPreferredPrinter: locked, bakedIndex: index(), ...settled() },
    { printerId: other.id }
  )
  assert.equal(result.printerId, 'locked')
  assert.equal(result.selectedPrinterModel, 'H2D')
})

test('a printer-less host resolves a manual target with no printer inputs at all', () => {
  const result = resolveWith({ machineProfiles: [H2D_04], bakedIndex: index({ compatiblePrinterModels: ['H2D'] }), ...settled() })
  assert.equal(result.targetMode, 'manualProfile')
  assert.equal(result.printerId, '')
  assert.equal(result.printerProfileId, H2D_04.id, 'the public host gets the same answer the workspace host does (I9)')
})

test('a conflict is only reported once the inputs have settled', () => {
  // Mid-load the catalogue genuinely cannot offer the pick yet; saying so would flash a warning on
  // every ordinary open. The applied value is the same either way.
  const loading = resolveWith({ machineProfiles: [H2D_04], bakedIndex: index({ compatiblePrinterModels: ['H2D'] }), projectResolved: true }, { printerModel: 'A1' })
  assert.deepEqual(loading.conflicts, [])
  const settledArgs = resolveWith({ machineProfiles: [H2D_04], bakedIndex: index({ compatiblePrinterModels: ['H2D'] }), ...settled() }, { printerModel: 'A1' })
  assert.equal(settledArgs.conflicts.length, 1)
})

test('resolution is deterministic: the same snapshot answers the same way every time', () => {
  const args = { machineProfiles: [A1_04, H2D_04, H2D_06], bakedIndex: index({ compatiblePrinterModels: ['H2D'] }), ...settled() }
  const first = resolveWith(args, { plateType: 'cool_plate' })
  const second = resolveWith(args, { plateType: 'cool_plate' })
  assert.deepEqual(
    [first.manualPrinterModel, first.printerProfileId, first.nozzleDiameter, first.plateType],
    [second.manualPrinterModel, second.printerProfileId, second.nozzleDiameter, second.plateType]
  )
})
