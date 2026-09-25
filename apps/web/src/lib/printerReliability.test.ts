import assert from 'node:assert/strict'
import test from 'node:test'
import type { WorkspacePrinterOutcome } from '@printstream/shared'
import { groupOutcomesByModel } from './printerReliability'

test('model reliability sums outcomes across printers and sorts by weighted success rate', () => {
  const printers: WorkspacePrinterOutcome[] = [
    { printerId: 'a1', name: 'A1', model: 'X1C', successfulPrints: 9, failedPrints: 1, cancelledPrints: 2 },
    { printerId: 'a2', name: 'A2', model: 'X1C', successfulPrints: 0, failedPrints: 1, cancelledPrints: 3 },
    { printerId: 'b1', name: 'B1', model: 'P1S', successfulPrints: 1, failedPrints: 1, cancelledPrints: 0 },
    { printerId: 'u1', name: 'Unknown', model: 'unknown', successfulPrints: 0, failedPrints: 0, cancelledPrints: 1 }
  ]

  assert.deepEqual(groupOutcomesByModel(printers), [
    { key: 'P1S', name: 'P1S', printerCount: 1, successfulPrints: 1, failedPrints: 1, cancelledPrints: 0 },
    { key: 'X1C', name: 'X1C', printerCount: 2, successfulPrints: 9, failedPrints: 2, cancelledPrints: 5 },
    { key: 'unknown', name: 'Unknown', printerCount: 1, successfulPrints: 0, failedPrints: 0, cancelledPrints: 1 }
  ])
})
