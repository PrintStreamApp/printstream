import assert from 'node:assert/strict'
import test from 'node:test'
import type { SlicingTarget } from '@printstream/shared'
import { buildDefaultAmsMappingFromSlicingTarget, resolveSlicingLeaveAction } from './slicingPrintHandoff'

test('buildDefaultAmsMappingFromSlicingTarget preserves saved AMS tray selections by project filament id', () => {
  const target: SlicingTarget = {
    mode: 'realPrinter',
    printerId: 'printer-1',
    filamentMappings: [
      {
        projectFilamentId: 1,
        source: 'ams',
        trayId: 1,
        toolheadId: 'nozzle-0'
      },
      {
        projectFilamentId: 3,
        source: 'externalSpool',
        trayId: 254,
        toolheadId: 'nozzle-1'
      }
    ]
  }

  assert.deepEqual(buildDefaultAmsMappingFromSlicingTarget(target), [1, -1, 254])
})

test('buildDefaultAmsMappingFromSlicingTarget ignores unmapped entries and returns null when no tray ids were saved', () => {
  const target: SlicingTarget = {
    mode: 'realPrinter',
    printerId: 'printer-1',
    filamentMappings: [
      {
        projectFilamentId: 1,
        source: 'manual',
        trayId: null,
        material: 'PLA Basic'
      }
    ]
  }

  assert.equal(buildDefaultAmsMappingFromSlicingTarget(target), null)
})

test('resolveSlicingLeaveAction cancels a still-running slice', () => {
  for (const status of ['queued', 'running', 'slicing', 'exporting']) {
    assert.equal(
      resolveSlicingLeaveAction({ status, outputFileId: null, printed: false }),
      'cancel',
      `expected ${status} to cancel`
    )
  }
})

test('resolveSlicingLeaveAction discards a finished-but-unused hidden output', () => {
  assert.equal(
    resolveSlicingLeaveAction({ status: 'ready', outputFileId: 'file-1', printed: false }),
    'discard'
  )
})

test('resolveSlicingLeaveAction keeps an output once it has been printed', () => {
  // The critical invariant: PrintModal calls onClose after a successful print, so the
  // leave path must NOT discard the file we just dispatched.
  assert.equal(
    resolveSlicingLeaveAction({ status: 'ready', outputFileId: 'file-1', printed: true }),
    'keep'
  )
})

test('resolveSlicingLeaveAction keeps when there is nothing to clean up', () => {
  // No job yet, no output id, or a terminal failed/cancelled job → nothing to undo.
  assert.equal(resolveSlicingLeaveAction({ status: null, outputFileId: null, printed: false }), 'keep')
  assert.equal(resolveSlicingLeaveAction({ status: 'ready', outputFileId: null, printed: false }), 'keep')
  assert.equal(resolveSlicingLeaveAction({ status: 'failed', outputFileId: 'file-1', printed: false }), 'keep')
  assert.equal(resolveSlicingLeaveAction({ status: 'cancelled', outputFileId: 'file-1', printed: false }), 'keep')
})