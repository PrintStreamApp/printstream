import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  defaultPrinterCardContentSettings,
  defaultPrinterViewSort,
  type PrinterView,
  type PrinterViewInput
} from '@printstream/shared'
import { isPrinterViewDraftDirty, printerViewInputWithContent, resolvePrinterViewContent } from './printerViewDraft.js'

const savedView: PrinterView = {
  id: 'saved-1',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  name: 'Workshop',
  cardsPerRow: 4,
  cardContentSettings: defaultPrinterCardContentSettings,
  sort: defaultPrinterViewSort,
  group: 'model',
  stateFilter: 'idle',
  modelFilter: [],
  nozzleDiameterFilter: ['0.4', '0.6'],
  plateTypeFilter: [],
  printerIds: ['printer-1', 'printer-2']
}

const overviewDefaults: PrinterViewInput = {
  ...savedView,
  name: 'Overview',
  cardsPerRow: 3,
  group: 'none',
  stateFilter: 'all',
  nozzleDiameterFilter: [],
  printerIds: []
}

test('saved-view draft overlays only toolbar fields and compares set-valued filters by membership', () => {
  const reordered = resolvePrinterViewContent(savedView, {
    nozzleDiameterFilter: ['0.6', '0.4'],
    printerIds: ['printer-2', 'printer-1']
  }, overviewDefaults)

  assert.equal(reordered.group, 'model')
  assert.equal(isPrinterViewDraftDirty(savedView, reordered), false)

  const changed = resolvePrinterViewContent(savedView, { stateFilter: 'printing' }, overviewDefaults)
  assert.equal(isPrinterViewDraftDirty(savedView, changed), true)
  assert.deepEqual(printerViewInputWithContent(savedView, changed), {
    name: 'Workshop',
    cardsPerRow: 4,
    cardContentSettings: defaultPrinterCardContentSettings,
    ...changed
  })
})

test('Overview ignores stale saved-view drafts and is never dirty', () => {
  const content = resolvePrinterViewContent(null, { stateFilter: 'printing' }, overviewDefaults)
  assert.equal(content, overviewDefaults)
  assert.equal(isPrinterViewDraftDirty(null, content), false)
})
