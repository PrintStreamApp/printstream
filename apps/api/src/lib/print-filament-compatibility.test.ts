import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PrinterStatus } from '@printstream/shared'
import { assertLibraryPrintCompatibilityForIndex } from './print-filament-compatibility.js'
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
} = {}): ThreeMfIndex {
  return {
    plates: [{
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
    compatiblePrinterModels: [],
    supportFilamentIds: [],
    printerProfileName: null,
    processProfileName: null
  }
}

function buildStatus(overrides: {
  nozzles?: Array<{ extruderId: number; diameter: string | null }>
  amsNozzleId?: number | null
  amsFilamentType?: string | null
} = {}): PrinterStatus {
  return {
    nozzles: overrides.nozzles ?? [],
    externalSpools: [],
    ams: [{
      unitId: 0,
      type: 'ams',
      nozzleId: overrides.amsNozzleId ?? null,
      slots: [{ slot: 0, filamentType: overrides.amsFilamentType ?? 'PLA' }]
    }]
  } as unknown as PrinterStatus
}

test('an undetected nozzle diameter does not block dispatch', () => {
  // No detected nozzles and no saved selection: the sliced 0.4 requirement has
  // nothing to compare against. Unknown must pass, not throw.
  assert.doesNotThrow(() => assertLibraryPrintCompatibilityForIndex(buildIndex(), {
    plate: 1,
    printerModel: 'H2D',
    printerStatus: buildStatus(),
    amsMapping: [0]
  }))
})

test('a partially detected nozzle diameter blocks only on the known conflict', () => {
  const index = buildIndex({
    filaments: [
      { id: 1, nozzleId: 0, nozzleDiameter: '0.4' },
      { id: 2, nozzleId: 1, nozzleDiameter: '0.4' }
    ]
  })

  // Extruder 0 detected and matching; extruder 1 undetected → allowed.
  assert.doesNotThrow(() => assertLibraryPrintCompatibilityForIndex(index, {
    plate: 1,
    printerModel: 'H2D',
    printerStatus: buildStatus({ nozzles: [{ extruderId: 0, diameter: '0.4' }] })
  }))

  // Extruder 0 detected and conflicting → still blocked.
  assert.throws(
    () => assertLibraryPrintCompatibilityForIndex(index, {
      plate: 1,
      printerModel: 'H2D',
      printerStatus: buildStatus({ nozzles: [{ extruderId: 0, diameter: '0.6' }] })
    }),
    /Installed nozzle size does not match/
  )
})

test('a known conflicting saved nozzle selection still blocks dispatch', () => {
  assert.throws(
    () => assertLibraryPrintCompatibilityForIndex(buildIndex(), {
      plate: 1,
      printerModel: 'X1C',
      printerStatus: buildStatus(),
      currentNozzleDiameters: [{ extruderId: 0, diameter: '0.6' }]
    }),
    /Installed nozzle size does not match/
  )
})

test('a tray nozzle mismatch blocks without the override and passes with it', () => {
  const index = buildIndex({
    filaments: [{ id: 1, nozzleId: 1 }],
    nozzleSizes: []
  })
  // The mapped tray's AMS feeds nozzle 0 while the filament is sliced for
  // nozzle 1 — a hard mismatch when the parsed binding is trusted.
  const input = {
    plate: 1,
    printerModel: 'H2D' as const,
    printerStatus: buildStatus({ amsNozzleId: 0 }),
    amsMapping: [0]
  }

  assert.throws(
    () => assertLibraryPrintCompatibilityForIndex(index, input),
    /incompatible with the sliced file/
  )
  assert.doesNotThrow(() => assertLibraryPrintCompatibilityForIndex(index, {
    ...input,
    allowIncompatibleFilament: true
  }))
})

test('a filament type mismatch keeps respecting the override flag', () => {
  const index = buildIndex({ nozzleSizes: [] })
  const input = {
    plate: 1,
    printerModel: 'X1C' as const,
    printerStatus: buildStatus({ amsFilamentType: 'PETG' }),
    amsMapping: [0]
  }

  assert.throws(
    () => assertLibraryPrintCompatibilityForIndex(index, input),
    /incompatible with the sliced file/
  )
  assert.doesNotThrow(() => assertLibraryPrintCompatibilityForIndex(index, {
    ...input,
    allowIncompatibleFilament: true
  }))
})
