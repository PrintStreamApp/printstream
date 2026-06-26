import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  serializePrinterViewModelFilter,
  serializePrinterViewNozzleDiameterFilter,
  serializePrinterViewPlateTypeFilter,
  toPrinterViewDto
} from './printer-view-record.js'

const baseRow = {
  id: 'view_1',
  name: 'Carbon X1Cs',
  printerIds: null,
  cardsPerRow: 3,
  stateFilter: 'all',
  modelFilter: '["X1C","P1S"]',
  nozzleDiameterFilter: '["0.4","0.8"]',
  plateTypeFilter: '["Textured PEI Plate"]',
  sortKey: 'name',
  sortDirection: 'asc',
  group: 'status',
  cardContentSettings: '{}',
  createdAt: new Date('2026-06-08T00:00:00.000Z'),
  updatedAt: new Date('2026-06-08T00:00:00.000Z')
}

test('toPrinterViewDto parses the stored attribute filters', () => {
  const dto = toPrinterViewDto(baseRow)
  assert.deepEqual(dto.modelFilter, ['X1C', 'P1S'])
  assert.deepEqual(dto.nozzleDiameterFilter, ['0.4', '0.8'])
  assert.deepEqual(dto.plateTypeFilter, ['Textured PEI Plate'])
  assert.equal(dto.group, 'status')
})

test('toPrinterViewDto defaults grouping to none for legacy/invalid rows', () => {
  assert.equal(toPrinterViewDto({ ...baseRow, group: 'bogus' }).group, 'none')
})

test('toPrinterViewDto falls back to empty filters for malformed or legacy rows', () => {
  const dto = toPrinterViewDto({
    ...baseRow,
    modelFilter: 'not json',
    nozzleDiameterFilter: '["0.4",""]',
    plateTypeFilter: '{}'
  })
  assert.deepEqual(dto.modelFilter, [])
  // The empty-string entry fails the schema's min(1) check, so the whole array
  // is rejected and falls back to empty rather than partially parsing.
  assert.deepEqual(dto.nozzleDiameterFilter, [])
  assert.deepEqual(dto.plateTypeFilter, [])
})

test('serialize helpers round-trip through the stored JSON shape', () => {
  assert.equal(serializePrinterViewModelFilter(['X1C']), '["X1C"]')
  assert.equal(serializePrinterViewNozzleDiameterFilter(['0.4', '0.8']), '["0.4","0.8"]')
  assert.equal(serializePrinterViewPlateTypeFilter([]), '[]')
})
