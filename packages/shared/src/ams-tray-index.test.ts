import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  amsTrayIndex,
  amsUnitLetter,
  amsUnitTypeFromCode,
  isPhysicalAmsTrayIndex,
  trayIndexToAmsSlot,
  AMS_HT_TRAY_INDEX_MIN
} from './ams-tray-index.js'
import { printerTrayMappingSchema } from './printer-contracts.js'

test('amsUnitTypeFromCode maps DevAmsType codes', () => {
  assert.equal(amsUnitTypeFromCode(0), 'ext-spool')
  assert.equal(amsUnitTypeFromCode(1), 'ams')
  assert.equal(amsUnitTypeFromCode(2), 'ams-lite')
  assert.equal(amsUnitTypeFromCode(3), 'ams-2-pro')
  assert.equal(amsUnitTypeFromCode(4), 'ams-ht')
  assert.equal(amsUnitTypeFromCode(5), 'ams-lite-mixed')
  assert.equal(amsUnitTypeFromCode(null), 'unknown')
  assert.equal(amsUnitTypeFromCode(99), 'unknown')
})

test('amsTrayIndex matches BambuStudio GetTrayIndexMap for classic AMS', () => {
  // unitId * 4 + slotId; a classic 4-unit layout spans 0-15.
  assert.equal(amsTrayIndex('ams', 0, 0), 0)
  assert.equal(amsTrayIndex('ams', 0, 3), 3)
  assert.equal(amsTrayIndex('ams-2-pro', 3, 3), 15)
  assert.equal(amsTrayIndex('ams-lite', 1, 2), 6)
})

test('amsTrayIndex uses the raw unit id for AMS HT (N3S)', () => {
  // The unit id itself (128-152) is the global tray index; slot is always 0.
  assert.equal(amsTrayIndex('ams-ht', 128, 0), 128)
  assert.equal(amsTrayIndex('ams-ht', 135, 0), 135)
})

test('amsTrayIndex offsets AMS Lite Mixed by 24', () => {
  assert.equal(amsTrayIndex('ams-lite-mixed', 0, 0), 24)
  assert.equal(amsTrayIndex('ams-lite-mixed', 0, 3), 27)
})

test('trayIndexToAmsSlot reverses the forward mapping', () => {
  assert.deepEqual(trayIndexToAmsSlot(0), { amsId: 0, slotId: 0 })
  assert.deepEqual(trayIndexToAmsSlot(15), { amsId: 3, slotId: 3 })
  assert.deepEqual(trayIndexToAmsSlot(128), { amsId: 128, slotId: 0 })
  assert.deepEqual(trayIndexToAmsSlot(152), { amsId: 152, slotId: 0 })
  // External virtual trays round-trip untouched.
  assert.deepEqual(trayIndexToAmsSlot(254), { amsId: 254, slotId: null })
  assert.deepEqual(trayIndexToAmsSlot(255), { amsId: 255, slotId: null })
  // Gaps between bands and negatives are rejected.
  assert.equal(trayIndexToAmsSlot(160), null)
  assert.equal(trayIndexToAmsSlot(-1), null)
})

test('round-trip forward then reverse for the H2 AMS HT band', () => {
  for (let unitId = AMS_HT_TRAY_INDEX_MIN; unitId <= AMS_HT_TRAY_INDEX_MIN + 5; unitId++) {
    const index = amsTrayIndex('ams-ht', unitId, 0)
    assert.deepEqual(trayIndexToAmsSlot(index), { amsId: unitId, slotId: 0 })
  }
})

test('isPhysicalAmsTrayIndex accepts real slots and rejects the gaps', () => {
  assert.equal(isPhysicalAmsTrayIndex(0), true)
  assert.equal(isPhysicalAmsTrayIndex(15), true)
  assert.equal(isPhysicalAmsTrayIndex(127), true)
  assert.equal(isPhysicalAmsTrayIndex(128), true)
  assert.equal(isPhysicalAmsTrayIndex(152), true)
  assert.equal(isPhysicalAmsTrayIndex(153), false)
  assert.equal(isPhysicalAmsTrayIndex(200), false)
  assert.equal(isPhysicalAmsTrayIndex(-1), false)
  assert.equal(isPhysicalAmsTrayIndex(1.5), false)
})

test('printerTrayMappingSchema accepts H2 AMS HT indices (regression for max(15) cap)', () => {
  // The bug: an 8-color H2C print mapped a color to an AMS HT tray (128+) and
  // the old max(15) cap rejected it with "Number must be less than or equal to 15".
  assert.equal(printerTrayMappingSchema.safeParse(128).success, true)
  assert.equal(printerTrayMappingSchema.safeParse(152).success, true)
  assert.equal(printerTrayMappingSchema.safeParse(15).success, true)
  assert.equal(printerTrayMappingSchema.safeParse(254).success, true)
  assert.equal(printerTrayMappingSchema.safeParse(255).success, true)
  // Still rejects the invalid gap between bands.
  assert.equal(printerTrayMappingSchema.safeParse(160).success, false)
  assert.equal(printerTrayMappingSchema.safeParse(-1).success, false)
})

test('amsUnitLetter folds the AMS HT band (128+) back to A-Y', () => {
  assert.equal(amsUnitLetter(0), 'A')
  assert.equal(amsUnitLetter(25), 'Z')
  assert.equal(amsUnitLetter(26), 'AA')
  // AMS HT units are numbered from 128; Bambu labels them A-Y by (id - 128).
  assert.equal(amsUnitLetter(128), 'A')
  assert.equal(amsUnitLetter(130), 'C')
})
