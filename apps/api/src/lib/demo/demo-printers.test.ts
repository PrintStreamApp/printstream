import assert from 'node:assert/strict'
import { test } from 'node:test'
import { printerStatusSchema, type Printer } from '@printstream/shared'
import {
  buildDemoPressureAdvanceProfiles,
  buildDemoStatus,
  DEMO_PRINTER_SEEDS,
  isReadyToUseDemoPrinter
} from './demo-printers.js'

function makePrinter(seed: (typeof DEMO_PRINTER_SEEDS)[number], id = seed.serial): Printer {
  return {
    id,
    name: seed.name,
    host: seed.host,
    serial: seed.serial,
    accessCode: seed.accessCode,
    model: seed.model,
    currentPlateType: seed.currentPlateType,
    currentNozzleDiameters: seed.currentNozzleDiameters,
    position: seed.position,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z'
  }
}

test('buildDemoStatus returns schema-valid seeded statuses for the demo fleet', () => {
  for (const seed of DEMO_PRINTER_SEEDS) {
    const status = buildDemoStatus(makePrinter(seed))
    assert.deepEqual(printerStatusSchema.parse(status), status)
    assert.equal(status.online, true)
  }
})

test('demo fleet includes six seeded printers with two of each model', () => {
  assert.equal(DEMO_PRINTER_SEEDS.length, 6)

  const counts = DEMO_PRINTER_SEEDS.reduce<Record<string, number>>((result, seed) => {
    result[seed.model] = (result[seed.model] ?? 0) + 1
    return result
  }, {})

  assert.deepEqual(counts, {
    X1C: 2,
    H2D: 2,
    P1S: 2
  })
})

test('buildDemoStatus marks seeded scenarios with distinct printer stages', () => {
  const ready = buildDemoStatus(makePrinter(DEMO_PRINTER_SEEDS[0]!))
  const earlyPrinting = buildDemoStatus(makePrinter(DEMO_PRINTER_SEEDS[1]!))
  const printing = buildDemoStatus(makePrinter(DEMO_PRINTER_SEEDS[4]!))
  const paused = buildDemoStatus(makePrinter(DEMO_PRINTER_SEEDS[2]!))
  const latePrinting = buildDemoStatus(makePrinter(DEMO_PRINTER_SEEDS[5]!))

  assert.equal(ready.stage, 'idle')
  assert.equal(ready.subStage, 'Ready to print')
  assert.equal(earlyPrinting.stage, 'printing')
  assert.equal(earlyPrinting.jobName, 'Number Plates')
  assert.equal(earlyPrinting.progressPercent, 7)
  assert.equal(printing.stage, 'printing')
  assert.equal(printing.jobName, 'Rail Mount')
  assert.equal(paused.stage, 'paused')
  assert.equal(paused.jobName, 'Card Holder (3 rows)')
  assert.equal(latePrinting.stage, 'printing')
  assert.equal(latePrinting.jobName, 'Tire Rotation Markers')
  assert.equal(latePrinting.progressPercent, 91)
})

test('the first seeded demo printer is the reserved ready-to-use printer', () => {
  assert.equal(isReadyToUseDemoPrinter(DEMO_PRINTER_SEEDS[0]!.serial), true)
  assert.equal(isReadyToUseDemoPrinter(DEMO_PRINTER_SEEDS[1]!.serial), false)
})

test('buildDemoStatus exposes dual-nozzle and external spool state for the H2D seed', () => {
  const h2d = buildDemoStatus(makePrinter(DEMO_PRINTER_SEEDS[1]!))

  assert.equal(h2d.nozzles.length, 2)
  assert.deepEqual(h2d.nozzles.map((entry) => entry.diameter), ['0.4', '0.4'])
  assert.equal(h2d.ams.length, 2)
  assert.equal(h2d.externalSpools.length, 2)
  assert.deepEqual(h2d.ductAvailableModes, ['cooling', 'heating'])
})

test('buildDemoStatus suppresses chamber temperature for P1S seeds and keeps H2D chamber telemetry', () => {
  const p1s = buildDemoStatus(makePrinter(DEMO_PRINTER_SEEDS[2]!))
  const h2d = buildDemoStatus(makePrinter(DEMO_PRINTER_SEEDS[1]!))

  assert.equal(p1s.chamberTemp, null)
  assert.equal(h2d.chamberTemp, 34)
})

test('buildDemoStatus exposes the main external spool for single-nozzle printers', () => {
  const x1c = buildDemoStatus(makePrinter(DEMO_PRINTER_SEEDS[0]!))

  assert.equal(x1c.externalSpools.length, 1)
  assert.equal(x1c.externalSpools[0]?.amsId, 255)
  assert.equal(x1c.externalSpools[0]?.nozzleId, 0)
})

test('demo fleet uses a broader filament color mix across seeded AMS trays', () => {
  const uniqueColors = new Set(
    DEMO_PRINTER_SEEDS.flatMap((seed) => buildDemoStatus(makePrinter(seed)).ams)
      .flatMap((unit) => unit.slots)
      .flatMap((slot) => slot.colors)
      .map((color) => color.toUpperCase())
  )

  assert.ok(uniqueColors.size >= 10)
})

test('demo fleet includes refill-ready duplicate AMS trays on multiple printers', () => {
  const refillReadyPrinters = DEMO_PRINTER_SEEDS.filter((seed) => {
    const status = buildDemoStatus(makePrinter(seed))
    return status.ams.some((unit) => {
      const loadedSlots = unit.slots.filter((slot) => slot.filamentType && slot.colors.length > 0)
      return loadedSlots.some((slot) => {
        if ((slot.remainPercent ?? 0) > 15) return false
        return loadedSlots.some((candidate) => (
          candidate.slot !== slot.slot
          && candidate.filamentType === slot.filamentType
          && JSON.stringify(candidate.colors) === JSON.stringify(slot.colors)
          && (candidate.trayInfoIdx ?? candidate.trayName) === (slot.trayInfoIdx ?? slot.trayName)
          && (candidate.remainPercent ?? 0) >= 35
        ))
      })
    })
  })

  assert.ok(refillReadyPrinters.length >= 4)
})

test('demo support materials only appear in the secondary AMS on dual-nozzle printers', () => {
  for (const seed of DEMO_PRINTER_SEEDS) {
    const status = buildDemoStatus(makePrinter(seed))
    const supportSlots = status.ams.flatMap((unit) => unit.slots.map((slot) => ({ unit, slot })))
      .filter(({ slot }) => (slot.filamentType ?? '').toLowerCase().includes('support'))

    if (seed.model !== 'H2D' && seed.model !== 'H2DPRO' && seed.model !== 'H2C' && seed.model !== 'X2D') {
      assert.equal(supportSlots.length, 0)
      continue
    }

    for (const { unit } of supportSlots) {
      assert.equal(unit.unitId, 1)
      assert.equal(unit.nozzleId, 1)
    }
  }
})

test('buildDemoPressureAdvanceProfiles returns canned demo profiles for the requested filament', () => {
  const profiles = buildDemoPressureAdvanceProfiles({
    filamentId: 'GFA00',
    extruderId: 0,
    nozzleDiameter: '0.4'
  })

  assert.equal(profiles.length, 3)
  assert.equal(profiles[0]?.filamentId, 'GFA00')
  assert.equal(profiles[0]?.nozzleDiameter, '0.4')
  assert.equal(profiles[1]?.name, 'Balanced walls')
})
