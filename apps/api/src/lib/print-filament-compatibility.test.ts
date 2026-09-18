import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PrinterStatus } from '@printstream/shared'
import { slotFilamentResolvers } from './slot-filament-registry.js'
import { assertAutomaticPrintCompatibility, assertLibraryPrintCompatibilityForIndex, InsufficientFilamentError } from './print-filament-compatibility.js'
import type { ThreeMfIndex } from './three-mf.js'

/**
 * Guard-behavior regression tests (issue #50): an *undetected* nozzle diameter
 * must never block dispatch (unknown is "can't prove incompatible", not
 * "incompatible"), and a tray→nozzle mismatch must be overridable with
 * `allowIncompatibleFilament` because the AMS→nozzle binding comes from status
 * parsing that can be wrong (H2D).
 */

function buildIndex(overrides: {
  filaments?: Array<Partial<ThreeMfIndex['plates'][number]['filaments'][number]> & { id: number }>
  nozzleSizes?: string[]
  slicedWithFilamentTrackSwitch?: boolean
  compatiblePrinterModels?: ThreeMfIndex['compatiblePrinterModels']
} = {}): ThreeMfIndex {
  return {
    plates: [{
      ...SCOPE,
      index: 1,
      name: null,
      gcodeFile: 'Metadata/plate_1.gcode',
      pickFile: null,
      thumbnailFile: null,
      plateType: null,
      nozzleSizes: overrides.nozzleSizes ?? ['0.4'],
      filaments: (overrides.filaments ?? [{ id: 1 }]).map((filament) => ({
        filamentType: 'PLA',
        filamentName: null,
        color: null,
        usedGrams: 10,
        usedMeters: 3,
        nozzleId: null,
        nozzleDiameter: null,
        chamberTemperature: null,
        ...filament
      })),
      objects: [],
      prediction: null,
      weight: null
    }],
    projectFilaments: [],
    compatiblePrinterModels: overrides.compatiblePrinterModels ?? [],
    supportFilamentIds: [],
    printerProfileName: null,
    processProfileName: null,
    processProfileInherits: null,
    geometryOnly: false,
    objectExport: false, needsSettingsRepair: false, settingsRepairReasons: [], projectVersion: null,
    slicedWithFilamentTrackSwitch: overrides.slicedWithFilamentTrackSwitch ?? false
  }
}

function buildStatus(overrides: {
  nozzles?: Array<{ extruderId: number; diameter: string | null }>
  amsNozzleId?: number | null
  amsFilamentType?: string | null
  filamentTrackSwitchInstalled?: boolean | null
} = {}): PrinterStatus {
  return {
    nozzles: overrides.nozzles ?? [],
    externalSpools: [],
    // null (the default) is what every machine reports today: no FTS signal at all.
    filamentTrackSwitch: overrides.filamentTrackSwitchInstalled == null ? null : {
      installed: overrides.filamentTrackSwitchInstalled,
      inputA: null,
      inputB: null,
      outputAExtruderId: null,
      outputBExtruderId: null,
      calibrating: false,
      filamentPresent: null
    },
    ams: [{
      unitId: 0,
      type: 'ams',
      nozzleId: overrides.amsNozzleId ?? null,
      slots: [{ slot: 0, filamentType: overrides.amsFilamentType ?? 'PLA' }]
    }]
  } as unknown as PrinterStatus
}

/** Workspace + printer the guard needs to look up tracked spool grams. */
const SCOPE = { workspaceId: 'workspace-1', printerId: 'printer-1' }

test('a printer model mismatch requires only its own explicit consent', async () => {
  const index = buildIndex({ compatiblePrinterModels: ['A1'] })
  const input = {
    ...SCOPE,
    plate: 1,
    printerModel: 'H2D' as const,
    printerStatus: buildStatus(),
    amsMapping: [0]
  }

  await assert.rejects(assertLibraryPrintCompatibilityForIndex(index, input), /Confirm the model mismatch/)
  await assert.rejects(
    assertLibraryPrintCompatibilityForIndex(index, { ...input, allowIncompatibleFilament: true }),
    /Confirm the model mismatch/
  )
  await assert.doesNotReject(
    assertLibraryPrintCompatibilityForIndex(index, { ...input, allowPrinterModelMismatch: true })
  )
})

test('an undetected nozzle diameter does not block dispatch', async () => {
  // No detected nozzles and no saved selection: the sliced 0.4 requirement has
  // nothing to compare against. Unknown must pass, not throw.
  await assert.doesNotReject(assertLibraryPrintCompatibilityForIndex(buildIndex(), {
    ...SCOPE,
    plate: 1,
    printerModel: 'H2D',
    printerStatus: buildStatus(),
    amsMapping: [0]
  }))
})

test('a partially detected nozzle diameter blocks only on the known conflict', async () => {
  const index = buildIndex({
    filaments: [
      { id: 1, nozzleId: 0, nozzleDiameter: '0.4' },
      { id: 2, nozzleId: 1, nozzleDiameter: '0.4' }
    ]
  })

  // Extruder 0 detected and matching; extruder 1 undetected → allowed.
  await assert.doesNotReject(assertLibraryPrintCompatibilityForIndex(index, {
    ...SCOPE,
    plate: 1,
    printerModel: 'H2D',
    printerStatus: buildStatus({ nozzles: [{ extruderId: 0, diameter: '0.4' }] })
  }))

  // Extruder 0 detected and conflicting → still blocked.
  await assert.rejects(
    assertLibraryPrintCompatibilityForIndex(index, {
      ...SCOPE,
      plate: 1,
      printerModel: 'H2D',
      printerStatus: buildStatus({ nozzles: [{ extruderId: 0, diameter: '0.6' }] })
    }),
    /Installed nozzle size does not match/
  )
})

test('a known conflicting saved nozzle selection still blocks dispatch', async () => {
  await assert.rejects(
    assertLibraryPrintCompatibilityForIndex(buildIndex(), {
      ...SCOPE,
      plate: 1,
      printerModel: 'X1C',
      printerStatus: buildStatus(),
      currentNozzleDiameters: [{ extruderId: 0, diameter: '0.6' }]
    }),
    /Installed nozzle size does not match/
  )
})

test('a tray nozzle mismatch blocks without the override and passes with it', async () => {
  const index = buildIndex({
    filaments: [{ id: 1, nozzleId: 1 }],
    nozzleSizes: []
  })
  // The mapped tray's AMS feeds nozzle 0 while the filament is sliced for
  // nozzle 1, a hard mismatch when the parsed binding is trusted.
  const input = {
    ...SCOPE,
    plate: 1,
    printerModel: 'H2D' as const,
    printerStatus: buildStatus({ amsNozzleId: 0 }),
    amsMapping: [0]
  }

  await assert.rejects(
    assertLibraryPrintCompatibilityForIndex(index, input),
    /incompatible with the sliced file/
  )
  await assert.doesNotReject(assertLibraryPrintCompatibilityForIndex(index, {
    ...input,
    allowIncompatibleFilament: true
  }))
})

test('a filament type mismatch keeps respecting the override flag', async () => {
  const index = buildIndex({ nozzleSizes: [] })
  const input = {
    ...SCOPE,
    plate: 1,
    printerModel: 'X1C' as const,
    printerStatus: buildStatus({ amsFilamentType: 'PETG' }),
    amsMapping: [0]
  }

  await assert.rejects(
    assertLibraryPrintCompatibilityForIndex(index, input),
    /incompatible with the sliced file/
  )
  await assert.doesNotReject(assertLibraryPrintCompatibilityForIndex(index, {
    ...input,
    allowIncompatibleFilament: true
  }))
})

test('a file must be printed on the kind of machine it was sliced for (Filament Track Switch)', async () => {
  const slicedWithSwitch = buildIndex({ slicedWithFilamentTrackSwitch: true })
  const slicedWithout = buildIndex()
  const dispatch = (index: ReturnType<typeof buildIndex>, printerStatus: PrinterStatus, allow = false) =>
    () => assertLibraryPrintCompatibilityForIndex(index, {
      ...SCOPE,
      plate: 1,
      printerModel: 'H2D',
      printerStatus,
      amsMapping: [0],
      allowFilamentTrackSwitchMismatch: allow
    })

  // Both directions are refused: the two cases group filaments across the extruders differently.
  await assert.rejects(dispatch(slicedWithout, buildStatus({ filamentTrackSwitchInstalled: true })), /has one fitted/)
  await assert.rejects(dispatch(slicedWithSwitch, buildStatus({ filamentTrackSwitchInstalled: false })), /does not have/)

  // Agreement passes in both directions.
  await assert.doesNotReject(dispatch(slicedWithSwitch, buildStatus({ filamentTrackSwitchInstalled: true })))
  await assert.doesNotReject(dispatch(slicedWithout, buildStatus({ filamentTrackSwitchInstalled: false })))

  // A printer that never mentions an FTS is UNKNOWN, not "no switch": refusing those would block
  // every print on today's firmware, which reports nothing at all.
  await assert.doesNotReject(dispatch(slicedWithSwitch, buildStatus()))
  await assert.doesNotReject(dispatch(slicedWithout, buildStatus()))

  // Offline printers cannot prove a mismatch either.
  await assert.doesNotReject(assertLibraryPrintCompatibilityForIndex(slicedWithSwitch, {
    ...SCOPE,
    plate: 1, printerModel: 'H2D', printerStatus: undefined, amsMapping: [0]
  }))

  // The SD-card / automatic path must enforce it too, a file already sitting on the printer is
  // exactly the case where nobody re-checked what it was sliced for.
  await assert.rejects(assertAutomaticPrintCompatibility({
    ...SCOPE,
    index: slicedWithout,
    plate: 1,
    printerModel: 'H2D',
    printerStatus: buildStatus({ filamentTrackSwitchInstalled: true }),
    useAms: true,
    amsMapping: [0]
  }), /has one fitted/)
  await assert.doesNotReject(assertAutomaticPrintCompatibility({
    ...SCOPE,
    index: slicedWithSwitch,
    plate: 1,
    printerModel: 'H2D',
    printerStatus: buildStatus({ filamentTrackSwitchInstalled: true }),
    useAms: true,
    amsMapping: [0]
  }))

  // Overridable, unlike in BambuStudio: we cannot read the capability flag that gates its hard
  // refusal, so a confirmed user must not be stranded with a library of un-printable files.
  await assert.doesNotReject(dispatch(slicedWithout, buildStatus({ filamentTrackSwitchInstalled: true }), true))

  // ...but ONLY by its own flag. Confirming the TRAY assignments is a different judgement and must
  // not silently also accept a file sliced for another class of machine.
  await assert.rejects(assertLibraryPrintCompatibilityForIndex(slicedWithout, {
    ...SCOPE,
    plate: 1,
    printerModel: 'H2D',
    printerStatus: buildStatus({ filamentTrackSwitchInstalled: true }),
    amsMapping: [0],
    allowIncompatibleFilament: true
  }), /has one fitted/)
  await assert.rejects(assertAutomaticPrintCompatibility({
    ...SCOPE,
    index: slicedWithout,
    plate: 1,
    printerModel: 'H2D',
    printerStatus: buildStatus({ filamentTrackSwitchInstalled: true }),
    useAms: true,
    amsMapping: [0],
    allowIncompatibleFilament: true
  }), /has one fitted/)
})

/**
 * Low-filament guard: the API's half of the print dialogs' "these slots will run out"
 * confirmation. Its job is to catch a stale tab or a third-party client, never to refuse
 * something the dialog showed as fine -- which means grading the same NUMBERS, so it reads
 * filament-manager's tracked grams back through the slot-filament resolver before refusing.
 */
function buildSufficiencyStatus(slots: Array<{
  remainPercent: number | null
  trayUuid?: string | null
}>, autoRefill = false): PrinterStatus {
  return {
    nozzles: [],
    externalSpools: [],
    filamentTrackSwitch: null,
    amsSettings: { autoRefill },
    ams: [{
      unitId: 0,
      type: 'ams',
      nozzleId: null,
      slots: slots.map((slot, index) => ({
        slot: index,
        filamentType: 'PLA',
        color: '#00B7EB',
        colors: ['#00B7EB'],
        trayName: 'Cyan',
        trayInfoIdx: 'GFA01',
        trayUuid: slot.trayUuid === undefined ? `UUID${index}` : slot.trayUuid,
        remainPercent: slot.remainPercent,
        occupied: true
      }))
    }]
  } as unknown as PrinterStatus
}

const sufficiencyIndex = () => buildIndex({ filaments: [{ id: 1, usedGrams: 200 }] })

test('a mapped slot that will run out blocks without the override and passes with it', async () => {
  const input = {
    ...SCOPE,
    plate: 1,
    printerModel: 'P1S' as const,
    printerStatus: buildSufficiencyStatus([{ remainPercent: 4 }]),
    amsMapping: [0]
  }

  await assert.rejects(
    assertLibraryPrintCompatibilityForIndex(sufficiencyIndex(), input),
    /Not enough filament loaded/
  )
  await assert.doesNotReject(
    assertLibraryPrintCompatibilityForIndex(sufficiencyIndex(), { ...input, allowInsufficientFilament: true })
  )
})

test('consenting to the tray assignments does not also consent to running out', async () => {
  // One checkbox must not grant two permissions: `allowIncompatibleFilament` says the materials
  // are right, which is silent on whether enough of them is left. If the sufficiency check ran
  // after that flag's early return, ticking it in the dialog would wave this through unasked.
  await assert.rejects(
    assertLibraryPrintCompatibilityForIndex(sufficiencyIndex(), {
      ...SCOPE,
      plate: 1,
      printerModel: 'P1S',
      printerStatus: buildSufficiencyStatus([{ remainPercent: 4 }]),
      amsMapping: [0],
      allowIncompatibleFilament: true
    }),
    /Not enough filament loaded/
  )
})

test('an auto-refill backup covers the shortfall, and an untagged spool is never called empty', async () => {
  const backed = {
    ...SCOPE,
    plate: 1,
    printerModel: 'P1S' as const,
    printerStatus: buildSufficiencyStatus([{ remainPercent: 12 }, { remainPercent: 30 }], true),
    amsMapping: [0]
  }
  await assert.doesNotReject(assertLibraryPrintCompatibilityForIndex(sufficiencyIndex(), backed))

  // A hand-set spool reports nothing measurable. Blocking dispatch on that would ground every
  // print using third-party filament.
  await assert.doesNotReject(assertLibraryPrintCompatibilityForIndex(sufficiencyIndex(), {
    ...SCOPE,
    plate: 1,
    printerModel: 'P1S',
    printerStatus: buildSufficiencyStatus([{ remainPercent: null, trayUuid: null }]),
    amsMapping: [0]
  }))
})

test('the storage-print guard applies the same rule', async () => {
  await assert.rejects(
    assertAutomaticPrintCompatibility({
      ...SCOPE,
      index: sufficiencyIndex(),
      plate: 1,
      printerModel: 'P1S',
      printerStatus: buildSufficiencyStatus([{ remainPercent: 4 }]),
      useAms: true,
      amsMapping: [0]
    }),
    /Not enough filament loaded/
  )
})

test('a tracked spool the browser graded as sufficient is not refused by the API', async () => {
  // The bug this pins: `knownRemainGrams` REPLACES the printer's percent with
  // filament-manager's tracked grams rather than taking the lower of the two, so a
  // tray the printer calls 4% full can genuinely hold 900g (a 5kg spool, or a
  // hand-weighed figure). The dialog graded that as fine and rendered no
  // confirmation, so a refusal here left the print unstartable from the UI.
  const off = slotFilamentResolvers.register(async ({ amsId, slotId }) =>
    amsId === 0 && slotId === 0
      ? { spoolId: 's1', brand: null, filamentType: 'PLA', materialSubtype: null, colorName: null, remainingGrams: 900 }
      : null)
  try {
    await assert.doesNotReject(assertLibraryPrintCompatibilityForIndex(sufficiencyIndex(), {
      ...SCOPE,
      plate: 1,
      printerModel: 'P1S',
      printerStatus: buildSufficiencyStatus([{ remainPercent: 4 }]),
      amsMapping: [0]
    }))
  } finally {
    off()
  }
})

test('a tracked spool that really is short is still refused', async () => {
  // The inverse, so the lookup cannot be satisfied by ignoring the guard: tracked
  // grams that CONFIRM the shortfall must still block.
  const off = slotFilamentResolvers.register(async () =>
    ({ spoolId: 's1', brand: null, filamentType: 'PLA', materialSubtype: null, colorName: null, remainingGrams: 30 }))
  try {
    await assert.rejects(
      assertLibraryPrintCompatibilityForIndex(sufficiencyIndex(), {
        ...SCOPE,
        plate: 1,
        printerModel: 'P1S',
        printerStatus: buildSufficiencyStatus([{ remainPercent: 4 }]),
        amsMapping: [0]
      }),
      /Not enough filament loaded/
    )
  } finally {
    off()
  }
})

test('a plate index the file does not have is not graded as plate 1', async () => {
  // The guard used to fall back to `index.plates[0]`, so a request naming a plate
  // that does not exist was refused over filament from a different plate entirely.
  await assert.doesNotReject(assertLibraryPrintCompatibilityForIndex(sufficiencyIndex(), {
    ...SCOPE,
    plate: 7,
    printerModel: 'P1S',
    printerStatus: buildSufficiencyStatus([{ remainPercent: 4 }]),
    amsMapping: [0]
  }))
})

test('the low-filament refusal is distinguishable from a genuine blocker', async () => {
  // The queue's "Check" reports this one as an advisory rather than a failure, because both
  // real Start paths go ahead with it. That downgrade keys off the error's type, so a plain
  // `conflict()` here would silently make Check call it a failure again.
  await assert.rejects(
    assertLibraryPrintCompatibilityForIndex(sufficiencyIndex(), {
      ...SCOPE,
      plate: 1,
      printerModel: 'P1S',
      printerStatus: buildSufficiencyStatus([{ remainPercent: 4 }]),
      amsMapping: [0]
    }),
    (error: unknown) => error instanceof InsufficientFilamentError && error.statusCode === 409
  )

  // A different guard must NOT be reported as one, or Check would wave through a real blocker.
  await assert.rejects(
    assertLibraryPrintCompatibilityForIndex(buildIndex({ filaments: [{ id: 1, nozzleDiameter: '0.4' }] }), {
      ...SCOPE,
      plate: 1,
      printerModel: 'X1C',
      printerStatus: buildStatus(),
      currentNozzleDiameters: [{ extruderId: 0, diameter: '0.6' }]
    }),
    (error: unknown) => error instanceof Error && !(error instanceof InsufficientFilamentError)
  )
})

/**
 * Filament blacklist (issue #94). BambuStudio refuses a prohibited material outright; we make it
 * overridable because the rules key on a nozzle flow/diameter we decode rather than are told, and a
 * misread nozzle must not make a correct setup un-printable. Warnings never block either way.
 */
/** A plate whose filament IS the TPU under test, so only the blacklist can object to it. */
function tpuIndex(): ThreeMfIndex {
  return buildIndex({ filaments: [{ id: 1, filamentType: 'TPU' }] })
}

test('a material Bambu prohibits on this hardware blocks dispatch', async () => {
  // TPU through an AMS is BambuStudio's oldest prohibition, and keys on nothing we could misread.
  await assert.rejects(
    assertLibraryPrintCompatibilityForIndex(tpuIndex(), {
      ...SCOPE,
      plate: 1,
      printerModel: 'P1S',
      printerStatus: buildStatus({ amsFilamentType: 'TPU' }),
      amsMapping: [0]
    }),
    /AMS A Slot 1: TPU is not supported by AMS/
  )
})

test('allowBlacklistedFilament overrides the prohibition, and nothing else does', async () => {
  const input = {
    ...SCOPE,
    plate: 1,
    printerModel: 'P1S' as const,
    printerStatus: buildStatus({ amsFilamentType: 'TPU' }),
    amsMapping: [0]
  }

  await assert.doesNotReject(assertLibraryPrintCompatibilityForIndex(tpuIndex(), {
    ...input,
    allowBlacklistedFilament: true
  }))

  // The tray-assignment consent is a different judgement and must not wave this through: it says
  // "these are the right materials for the file", not "I accept damaging the printer".
  await assert.rejects(
    assertLibraryPrintCompatibilityForIndex(tpuIndex(), { ...input, allowIncompatibleFilament: true }),
    /TPU is not supported by AMS/
  )
})

test('a blacklist WARNING never blocks dispatch', async () => {
  // PVA in an AMS is a warning ("dry it before use"), not a prohibition. The dialog shows it; the
  // guard must not refuse on it, or ordinary support-material prints would stop working.
  await assert.doesNotReject(assertLibraryPrintCompatibilityForIndex(
    buildIndex({ filaments: [{ id: 1, filamentType: 'PVA' }] }),
    {
      ...SCOPE,
      plate: 1,
      printerModel: 'P1S',
      printerStatus: buildStatus({ amsFilamentType: 'PVA' }),
      amsMapping: [0]
    }
  ))
})

test('an unmapped tray is not graded, however bad the material in it is', async () => {
  // The guard checks the trays this print will USE. A TPU spool sitting in an unmapped slot is not
  // this print's problem, and refusing over it would be a refusal the dialog never showed.
  await assert.doesNotReject(assertLibraryPrintCompatibilityForIndex(tpuIndex(), {
    ...SCOPE,
    plate: 1,
    printerModel: 'P1S',
    printerStatus: buildStatus({ amsFilamentType: 'TPU' }),
    amsMapping: []
  }))
})

test('the printer-storage path enforces the blacklist too', async () => {
  // Same rules, different source: printing a file already on the printer's SD card still puts the
  // same material through the same hardware.
  await assert.rejects(
    assertAutomaticPrintCompatibility({
      ...SCOPE,
      index: null,
      plate: 1,
      printerModel: 'P1S',
      printerStatus: buildStatus({ amsFilamentType: 'TPU' }),
      useAms: true,
      amsMapping: [0]
    }),
    /TPU is not supported by AMS/
  )
})

test('inventory-backed Bambu PET-CF still blocks dispatch after manual identity is cleared', async () => {
  const off = slotFilamentResolvers.register(async (query) => {
    assert.equal(query.workspaceId, SCOPE.workspaceId)
    return { spoolId: 'inventory-spool', brand: 'Bambu', filamentType: 'PET-CF', materialSubtype: 'PET-CF', colorName: 'Black', remainingGrams: null }
  })
  try {
    const input = { ...SCOPE, plate: 1, printerModel: 'P1S' as const, printerStatus: buildStatus({ amsFilamentType: 'PET-CF' }), amsMapping: [0] }
    await assert.rejects(assertAutomaticPrintCompatibility({ ...input, index: null, useAms: true }), /PET-CF/)
    await assert.doesNotReject(assertAutomaticPrintCompatibility({ ...input, index: null, useAms: true, allowBlacklistedFilament: true }))
  } finally {
    off()
  }
})
