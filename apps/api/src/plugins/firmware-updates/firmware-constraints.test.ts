import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateOfflineUpdate, evaluatePrerequisite } from './firmware-constraints.js'

test('evaluateOfflineUpdate flags installed firmware below a model floor', () => {
  // P1 offline-update floor is 01.07.00.00.
  assert.deepEqual(evaluateOfflineUpdate('p1', '01.06.01.02'), {
    minimumVersion: '01.07.00.00',
    belowMinimum: true
  })
  assert.deepEqual(evaluateOfflineUpdate('p1', '01.07.00.00'), {
    minimumVersion: '01.07.00.00',
    belowMinimum: false
  })
  assert.deepEqual(evaluateOfflineUpdate('p1', '01.10.00.00'), {
    minimumVersion: '01.07.00.00',
    belowMinimum: false
  })
})

test('evaluateOfflineUpdate reports the X1 / A1 / X1E floors', () => {
  assert.equal(evaluateOfflineUpdate('x1', '01.08.01.00').belowMinimum, true)
  assert.equal(evaluateOfflineUpdate('x1', '01.08.02.00').belowMinimum, false)
  assert.equal(evaluateOfflineUpdate('a1', '01.03.99.99').belowMinimum, true)
  assert.equal(evaluateOfflineUpdate('a1-mini', '01.04.00.00').belowMinimum, false)
  assert.equal(evaluateOfflineUpdate('x1e', '01.01.00.00').belowMinimum, true)
})

test('evaluateOfflineUpdate never guesses a block for unknown models or unknown firmware', () => {
  // H2 series shipped with offline updates — no floor.
  assert.deepEqual(evaluateOfflineUpdate('h2d', '01.00.00.00'), { minimumVersion: null, belowMinimum: false })
  // Unmapped / unknown API key.
  assert.deepEqual(evaluateOfflineUpdate(null, '01.00.00.00'), { minimumVersion: null, belowMinimum: false })
  // Installed firmware not yet known — do not block on a guess.
  assert.equal(evaluateOfflineUpdate('p1', null).belowMinimum, false)
})

test('evaluatePrerequisite requires the P1 Bridge Firmware before jumping past it', () => {
  // Below the bridge, targeting a version above it -> must install the bridge first.
  assert.deepEqual(evaluatePrerequisite('p1', '01.08.02.00', '01.10.00.00'), {
    requiredVersion: '01.09.01.00',
    label: 'Bridge Firmware'
  })
  // Installing the bridge itself is allowed (it is the intermediate).
  assert.equal(evaluatePrerequisite('p1', '01.08.02.00', '01.09.01.00'), null)
  // Already at/above the bridge -> direct jump is fine.
  assert.equal(evaluatePrerequisite('p1', '01.09.01.00', '01.10.00.00'), null)
  // Target at or below the bridge -> no hop needed.
  assert.equal(evaluatePrerequisite('p1', '01.08.00.00', '01.09.00.00'), null)
})

test('evaluatePrerequisite requires the X1E helper build for 01.01.02.00-and-earlier', () => {
  assert.deepEqual(evaluatePrerequisite('x1e', '01.01.02.00', '01.02.00.00'), {
    requiredVersion: '01.01.50.02',
    label: 'helper firmware'
  })
  // A printer already past the gated range jumps directly even though it is below the helper build.
  assert.equal(evaluatePrerequisite('x1e', '01.01.50.02', '01.02.02.00'), null)
})

test('evaluatePrerequisite returns null when inputs are unknown or the model has no hops', () => {
  assert.equal(evaluatePrerequisite('a1', '01.04.00.00', '01.10.00.00'), null)
  assert.equal(evaluatePrerequisite('p1', null, '01.10.00.00'), null)
  assert.equal(evaluatePrerequisite('p1', '01.08.00.00', null), null)
  assert.equal(evaluatePrerequisite(null, '01.08.00.00', '01.10.00.00'), null)
})
