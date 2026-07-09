import assert from 'node:assert/strict'
import { test } from 'node:test'
import { amsTrayIndex } from '@printstream/shared'
import { calibrationAmsMapping, shouldApplyKValue } from './run-manager.js'

test('shouldApplyKValue only pushes a resolved value that differs from the slot', () => {
  // Nothing saved -> never push.
  assert.equal(shouldApplyKValue(null, 0.02), false)
  // Saved but printer has no K yet -> push.
  assert.equal(shouldApplyKValue(0.02, null), true)
  // Saved differs from current -> push.
  assert.equal(shouldApplyKValue(0.024, 0.02), true)
  // Saved already applied (within tolerance) -> skip the redundant MQTT write.
  assert.equal(shouldApplyKValue(0.02, 0.02), false)
  assert.equal(shouldApplyKValue(0.02, 0.020005), false)
})

test('calibrationAmsMapping pins the chosen tray, or defers to the printer default when unknown', () => {
  // The reported bug: AMS A (unit 0) slot 2 (slotId 1) must map to global tray index 1, so the
  // print uses slot 2 and not the printer's default (tray 0 / slot 1).
  const trayIndex = amsTrayIndex('ams-2-pro', 0, 1)
  assert.equal(trayIndex, 1)
  assert.deepEqual(calibrationAmsMapping(trayIndex), [1])
  // AMS B (unit 1) slot 1 (slotId 0) -> global tray 4.
  assert.deepEqual(calibrationAmsMapping(amsTrayIndex('ams-2-pro', 1, 0)), [4])
  // Unknown tray (slot not in live status) -> omit ams_mapping so dispatch keeps the printer default.
  assert.equal(calibrationAmsMapping(null), undefined)
})
