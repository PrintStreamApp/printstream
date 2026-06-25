process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PrinterStatus } from '@printstream/shared'
import {
  computeRemainPercent,
  deriveStatus,
  parseColors,
  serializeColors,
  toSpoolDto,
  type SpoolRowWithPrinter
} from './dto.js'
import { trayIndexToSlot, parseAmsMapping } from './consumption.js'
import { collectPresences, signature } from './status-sync.js'

function makeRow(overrides: Partial<SpoolRowWithPrinter> = {}): SpoolRowWithPrinter {
  const base = {
    id: 'spool-1',
    tenantId: 'tenant-1',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-02T00:00:00.000Z'),
    deletedAt: null,
    archivedAt: null,
    brand: 'Bambu',
    filamentType: 'PLA',
    materialSubtype: null,
    colorName: null,
    colorHex: '#FF0000',
    colorsJson: null,
    trayInfoIdx: 'GFA00',
    bambuUuid: null,
    serial: null,
    nozzleTempMin: null,
    nozzleTempMax: null,
    diameterMm: 1.75,
    netWeightGrams: 1000,
    spoolCoreGrams: null,
    remainingGrams: 500,
    remainSource: 'manual',
    costCents: null,
    currency: null,
    purchasedAt: null,
    vendor: null,
    notes: null,
    loadedPrinterId: null,
    loadedAmsId: null,
    loadedSlotId: null,
    loadedAt: null,
    lastSeenAt: null,
    loadedPrinter: null
  }
  return { ...base, ...overrides } as SpoolRowWithPrinter
}

test('computeRemainPercent clamps and handles unknown net weight', () => {
  assert.equal(computeRemainPercent(500, 1000), 50)
  assert.equal(computeRemainPercent(0, 1000), 0)
  assert.equal(computeRemainPercent(1500, 1000), 100)
  assert.equal(computeRemainPercent(500, 0), null)
})

test('deriveStatus precedence: archived > empty > low > loaded > available', () => {
  assert.equal(deriveStatus({ archivedAt: new Date(), remainingGrams: 500, loadedPrinterId: null, remainPercent: 50 }), 'archived')
  assert.equal(deriveStatus({ archivedAt: null, remainingGrams: 0, loadedPrinterId: 'p', remainPercent: 0 }), 'empty')
  // Loaded + low reads as "low" (fill level wins over location).
  assert.equal(deriveStatus({ archivedAt: null, remainingGrams: 50, loadedPrinterId: 'p', remainPercent: 5 }), 'low')
  assert.equal(deriveStatus({ archivedAt: null, remainingGrams: 50, loadedPrinterId: null, remainPercent: 5 }), 'low')
  // Loaded + healthy reads as "loaded".
  assert.equal(deriveStatus({ archivedAt: null, remainingGrams: 800, loadedPrinterId: 'p', remainPercent: 80 }), 'loaded')
  assert.equal(deriveStatus({ archivedAt: null, remainingGrams: 800, loadedPrinterId: null, remainPercent: 80 }), 'available')
})

test('parseColors / serializeColors round-trip and tolerate junk', () => {
  assert.deepEqual(parseColors(serializeColors(['#FFFFFF', '#000000'])), ['#FFFFFF', '#000000'])
  assert.equal(serializeColors([]), null)
  assert.deepEqual(parseColors(null), [])
  assert.deepEqual(parseColors('not json'), [])
  assert.deepEqual(parseColors('{"a":1}'), [])
})

test('toSpoolDto derives remainPercent, status and printer name', () => {
  const dto = toSpoolDto(makeRow({
    remainingGrams: 500,
    netWeightGrams: 1000,
    loadedPrinterId: 'printer-1',
    loadedAmsId: 0,
    loadedSlotId: 2,
    loadedPrinter: { name: 'X1C' }
  }))
  assert.equal(dto.remainPercent, 50)
  assert.equal(dto.status, 'loaded')
  assert.equal(dto.loadedPrinterName, 'X1C')
  assert.equal(dto.createdAt, '2026-06-01T00:00:00.000Z')
})

test('trayIndexToSlot maps AMS global indices and external trays', () => {
  assert.deepEqual(trayIndexToSlot(0), { amsId: 0, slotId: 0 })
  assert.deepEqual(trayIndexToSlot(3), { amsId: 0, slotId: 3 })
  assert.deepEqual(trayIndexToSlot(5), { amsId: 1, slotId: 1 })
  assert.deepEqual(trayIndexToSlot(15), { amsId: 3, slotId: 3 })
  assert.deepEqual(trayIndexToSlot(254), { amsId: 254, slotId: null })
  assert.deepEqual(trayIndexToSlot(255), { amsId: 255, slotId: null })
  assert.equal(trayIndexToSlot(-1), null)
  assert.equal(trayIndexToSlot(16), null)
})

test('parseAmsMapping handles valid, null, and malformed input', () => {
  assert.deepEqual(parseAmsMapping('[255,10,254]'), [255, 10, 254])
  assert.equal(parseAmsMapping(null), null)
  assert.equal(parseAmsMapping('not json'), null)
  assert.equal(parseAmsMapping('{"a":1}'), null)
})

function makeStatus(): PrinterStatus {
  return {
    printerId: 'printer-1',
    ams: [
      {
        unitId: 0,
        slots: [
          { slot: 0, trayUuid: 'uuid-a', remainPercent: 80, filamentType: 'PLA', color: '#FF0000', colors: ['#FF0000'], trayInfoIdx: 'GFA00' },
          { slot: 1, trayUuid: null, remainPercent: null, filamentType: null, color: null, colors: [], trayInfoIdx: null }
        ]
      }
    ],
    externalSpools: [
      { amsId: 255, trayUuid: 'uuid-ext', remainPercent: 50, filamentType: 'PETG', color: '#00FF00', colors: ['#00FF00'], trayInfoIdx: 'GFG00' }
    ]
  } as unknown as PrinterStatus
}

test('collectPresences keeps only RFID-tagged slots, including external spools', () => {
  const presences = collectPresences(makeStatus())
  assert.equal(presences.length, 2)
  assert.deepEqual(presences[0], {
    amsId: 0, slotId: 0, trayUuid: 'uuid-a', remainPercent: 80, filamentType: 'PLA', color: '#FF0000', colors: ['#FF0000'], trayInfoIdx: 'GFA00'
  })
  assert.equal(presences[1]?.amsId, 255)
  assert.equal(presences[1]?.slotId, null)
})

test('signature changes when remaining percent changes', () => {
  const a = collectPresences(makeStatus())
  const status2 = makeStatus()
  status2.ams[0]!.slots[0]!.remainPercent = 79
  const b = collectPresences(status2)
  assert.notEqual(signature(a), signature(b))
})
