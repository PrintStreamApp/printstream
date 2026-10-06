import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  defaultPrinterCardContentSettings,
  defaultPrinterViewSort,
  type PrinterView,
  type PrinterViewInput
} from '@printstream/shared'
import { savedViewDialogState } from './printerViewDialogState.js'

const committed: PrinterView = {
  id: 'saved-1',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  name: 'Workshop',
  printerIds: ['printer-1'],
  cardsPerRow: 4,
  stateFilter: 'idle',
  modelFilter: [],
  nozzleDiameterFilter: [],
  plateTypeFilter: [],
  sort: defaultPrinterViewSort,
  group: 'model',
  cardContentSettings: defaultPrinterCardContentSettings
}

const displayed: PrinterViewInput = {
  ...committed,
  name: '',
  printerIds: ['printer-2'],
  stateFilter: 'printing',
  group: 'none'
}

test('settings begin with committed content even while the toolbar has a draft', () => {
  const settings = savedViewDialogState('settings', committed, displayed)
  assert.equal(settings.name, 'Workshop')
  assert.deepEqual(settings.printerIds, ['printer-1'])
  assert.equal(settings.stateFilter, 'idle')
  assert.equal(settings.group, 'model')
})

test('creation and Overview settings begin with the current display', () => {
  assert.equal(savedViewDialogState('create', committed, displayed), displayed)
  assert.equal(savedViewDialogState('settings', null, displayed), displayed)
})
