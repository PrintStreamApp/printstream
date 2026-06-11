import assert from 'node:assert/strict'
import test from 'node:test'
import type { SlicingTarget } from '@printstream/shared'
import { buildDefaultAmsMappingFromSlicingTarget } from './slicingPrintHandoff'

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