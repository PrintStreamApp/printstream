import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FilamentSpool } from '@printstream/shared'
import {
  applyFilters, sortSpools, groupSpools, spoolTitle, formatLoadedLocation, deriveFacets, EMPTY_FILTERS
} from './filters'

function makeSpool(overrides: Partial<FilamentSpool> = {}): FilamentSpool {
  const base: FilamentSpool = {
    id: 'spool-1',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    deletedAt: null,
    archivedAt: null,
    brand: 'Bambu',
    filamentType: 'PLA',
    materialSubtype: null,
    colorName: 'Scarlet Red',
    colorHex: '#C12E1F',
    colors: ['#C12E1F'],
    trayInfoIdx: 'GFA00',
    bambuUuid: null,
    serial: null,
    nozzleTempMin: null,
    nozzleTempMax: null,
    diameterMm: 1.75,
    netWeightGrams: 1000,
    spoolCoreGrams: null,
    remainingGrams: 500,
    remainPercent: 50,
    remainSource: 'manual',
    status: 'available',
    costCents: null,
    currency: null,
    purchasedAt: null,
    vendor: null,
    notes: null,
    loadedPrinterId: null,
    loadedPrinterName: null,
    loadedAmsId: null,
    loadedSlotId: null,
    loadedAt: null,
    lastSeenAt: null
  }
  return { ...base, ...overrides }
}

test('spoolTitle combines brand, material and colour', () => {
  assert.equal(spoolTitle(makeSpool()), 'Bambu PLA — Scarlet Red')
  assert.equal(spoolTitle(makeSpool({ brand: null, colorName: null, colorHex: null })), 'PLA')
})

test('applyFilters honours search, type, and status', () => {
  const spools = [
    makeSpool({ id: 'a', filamentType: 'PLA', brand: 'Bambu', status: 'available' }),
    makeSpool({ id: 'b', filamentType: 'PETG', brand: 'Polymaker', status: 'loaded', colorName: 'Blue' })
  ]
  assert.deepEqual(applyFilters(spools, { ...EMPTY_FILTERS, search: 'polymaker' }).map((s) => s.id), ['b'])
  assert.deepEqual(applyFilters(spools, { ...EMPTY_FILTERS, types: ['PETG'] }).map((s) => s.id), ['b'])
  assert.deepEqual(applyFilters(spools, { ...EMPTY_FILTERS, statuses: ['available'] }).map((s) => s.id), ['a'])
  assert.equal(applyFilters(spools, EMPTY_FILTERS).length, 2)
})

test('sortSpools orders by remaining in both directions', () => {
  const spools = [makeSpool({ id: 'lo', remainingGrams: 100 }), makeSpool({ id: 'hi', remainingGrams: 900 })]
  assert.deepEqual(sortSpools(spools, 'remaining', 'asc').map((s) => s.id), ['lo', 'hi'])
  assert.deepEqual(sortSpools(spools, 'remaining', 'desc').map((s) => s.id), ['hi', 'lo'])
})

test('groupSpools buckets by material and "none" returns one group', () => {
  const spools = [makeSpool({ filamentType: 'PLA' }), makeSpool({ filamentType: 'PETG' }), makeSpool({ filamentType: 'PLA' })]
  const byType = groupSpools(spools, 'type')
  assert.deepEqual(byType.map((g) => `${g.label}:${g.spools.length}`), ['PETG:1', 'PLA:2'])
  assert.equal(groupSpools(spools, 'none').length, 1)
})

test('formatLoadedLocation describes AMS, external, and unloaded spools', () => {
  assert.equal(formatLoadedLocation(makeSpool()), null)
  assert.equal(
    formatLoadedLocation(makeSpool({ loadedPrinterId: 'p', loadedPrinterName: 'X1C', loadedAmsId: 0, loadedSlotId: 1 })),
    'X1C · AMS A slot 2'
  )
  assert.equal(
    formatLoadedLocation(makeSpool({ loadedPrinterId: 'p', loadedPrinterName: 'P1S', loadedAmsId: 255, loadedSlotId: null })),
    'P1S · External spool (right)'
  )
})

test('deriveFacets returns sorted unique types and brands', () => {
  const facets = deriveFacets([
    makeSpool({ filamentType: 'PETG', brand: 'Polymaker' }),
    makeSpool({ filamentType: 'PLA', brand: 'Bambu' }),
    makeSpool({ filamentType: 'PLA', brand: null })
  ])
  assert.deepEqual(facets.types, ['PETG', 'PLA'])
  assert.deepEqual(facets.brands, ['Bambu', 'Polymaker'])
})
