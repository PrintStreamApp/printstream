/**
 * The dialog-side bridge into the shared print matcher. The matcher itself is
 * covered in `packages/shared`; these tests pin the web-only adaptations —
 * tracked-spool grams reaching the right slot (including the AMS HT 128+ band,
 * whose tray index reverse-maps to `amsId = unitId`, not `unitId * 4`), and
 * the auto-selected derivation that drives the row markers.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrinterStatus, ThreeMfProjectFilament } from '@printstream/shared'
import { autoSelectedFilamentIds, buildAutoMatchSlots, computeAutoTrayMapping } from './autoTrayMatch'
import type { SlotFilamentIdentity, SlotFilamentIdentityLookup } from './slotFilamentIdentity'

function statusWith(options: {
  ams?: Array<Record<string, unknown>>
  externalSpools?: Array<Record<string, unknown>>
  autoRefill?: boolean
}): PrinterStatus {
  return {
    online: true,
    stage: 'idle',
    ams: options.ams ?? [],
    externalSpools: options.externalSpools ?? [],
    amsSettings: { autoRefill: options.autoRefill ?? false }
  } as unknown as PrinterStatus
}

function filament(id: number, filamentType: string, color: string, nozzleId: number | null = null): ThreeMfProjectFilament {
  return { id, filamentType, filamentName: null, color, nozzleId, chamberTemperature: null }
}

const NO_SPOOLS: SlotFilamentIdentityLookup = () => null

test('buildAutoMatchSlots attaches tracked-spool grams by physical slot, including the AMS HT band', () => {
  const status = statusWith({
    ams: [
      { unitId: 1, nozzleId: null, slots: [{ slot: 2, filamentType: 'PLA', color: '#000000', occupied: true }] },
      { unitId: 130, type: 'ams-ht', nozzleId: null, slots: [{ slot: 0, filamentType: 'PETG', color: '#FFFFFF', occupied: true }] }
    ]
  })
  const seen: Array<{ amsId: number | null | undefined; slotId: number | null | undefined }> = []
  const lookup: SlotFilamentIdentityLookup = (_printerId, amsId, slotId) => {
    seen.push({ amsId, slotId })
    // Track only the HT slot's spool: amsId is the unit id itself (130), slot 0.
    if (amsId === 130 && slotId === 0) return { spoolId: 's1', remainingGrams: 420 } as SlotFilamentIdentity
    return null
  }
  const slots = buildAutoMatchSlots('printer-1', status, lookup)
  // The regular tray resolved through unitId*4+slot → (1, 2); the HT tray through (130, 0).
  assert.deepEqual(seen, [{ amsId: 1, slotId: 2 }, { amsId: 130, slotId: 0 }])
  assert.equal(slots[0]?.remainingGrams, undefined)
  assert.equal(slots[1]?.remainingGrams, 420)
})

test('computeAutoTrayMapping suggests exact matches only and returns empty with no status', () => {
  const status = statusWith({
    ams: [{
      unitId: 0,
      nozzleId: null,
      slots: [
        { slot: 0, filamentType: 'PLA', color: '#000000', occupied: true },
        { slot: 1, filamentType: 'PLA', color: '#FF0000', occupied: true }
      ]
    }]
  })
  const filaments = [filament(1, 'PLA', '#FF0000'), filament(2, 'PETG', '#000000')]
  // #1 has an exact match (slot 1); #2 is PETG — the type-only PLA candidates must stay unselected.
  assert.deepEqual(computeAutoTrayMapping('printer-1', status, filaments, new Map(), NO_SPOOLS), [1, -1])
  assert.deepEqual(computeAutoTrayMapping('printer-1', undefined, filaments, new Map(), NO_SPOOLS), [])
})

test('autoSelectedFilamentIds flags only rows the auto match filled and no explicit pick covers', () => {
  const filaments = [filament(1, 'PLA', '#000000'), filament(2, 'PLA', '#FF0000'), filament(3, 'PETG', '#FFFFFF')]
  // #1 auto-filled; #2 explicitly picked (explicit wins); #3 unmatched.
  const ids = autoSelectedFilamentIds(filaments, [4, 5, -1], [-1, 9])
  assert.deepEqual([...ids].sort(), [1])
})
