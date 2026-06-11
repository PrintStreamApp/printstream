import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shouldConfirmChamberLightTurnOff } from './chamberLightWarning'

test('shouldConfirmChamberLightTurnOff only intercepts chamber light-off commands when the printer requests recheck', () => {
  assert.equal(
    shouldConfirmChamberLightTurnOff(
      { chamberLightOffRequiresConfirm: true },
      { type: 'light', node: 'chamber', on: false }
    ),
    true
  )

  assert.equal(
    shouldConfirmChamberLightTurnOff(
      { chamberLightOffRequiresConfirm: false },
      { type: 'light', node: 'chamber', on: false }
    ),
    false
  )

  assert.equal(
    shouldConfirmChamberLightTurnOff(
      { chamberLightOffRequiresConfirm: true },
      { type: 'light', node: 'chamber', on: true }
    ),
    false
  )

  assert.equal(
    shouldConfirmChamberLightTurnOff(
      { chamberLightOffRequiresConfirm: true },
      { type: 'light', node: 'heatbed', on: false }
    ),
    false
  )
})