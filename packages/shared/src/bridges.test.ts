import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bridgeUpdateBlocksPrinting,
  bridgeUpdateNeedsAttention,
  bridgeUpdateSupportsInAppUpdate,
  bridgeUpdateStatusSchema,
  type BridgeUpdateStatus
} from './bridges.js'

const ALL_STATUSES = bridgeUpdateStatusSchema.options as readonly BridgeUpdateStatus[]

test('bridgeUpdateBlocksPrinting blocks only incompatible statuses', () => {
  const blocking: BridgeUpdateStatus[] = ['updateRequired', 'runnerUpdateRequired', 'unsupported']
  // imageUpdateRequired warns without blocking: bundle self-updates keep the
  // app code lockstep, so a drifted runner image is a rebuild reminder.
  const allowed: BridgeUpdateStatus[] = ['unknown', 'current', 'updateAvailable', 'updateHeldBack', 'imageUpdateRequired']
  for (const status of blocking) assert.equal(bridgeUpdateBlocksPrinting(status), true, `${status} should block`)
  for (const status of allowed) assert.equal(bridgeUpdateBlocksPrinting(status), false, `${status} should not block`)
  // Exhaustive: every enum value is classified.
  assert.equal(new Set([...blocking, ...allowed]).size, ALL_STATUSES.length)
})

test('bridgeUpdateNeedsAttention surfaces everything except current/unknown', () => {
  assert.equal(bridgeUpdateNeedsAttention('current'), false)
  assert.equal(bridgeUpdateNeedsAttention('unknown'), false)
  for (const status of ALL_STATUSES.filter((s) => s !== 'current' && s !== 'unknown')) {
    assert.equal(bridgeUpdateNeedsAttention(status), true, `${status} should need attention`)
  }
})

test('bridgeUpdateSupportsInAppUpdate excludes image/runner updates (which need an operator restart)', () => {
  // `unsupported` is still offered an in-place update attempt (matching the settings
  // UI): only image/runner updates genuinely require an operator image pull + restart.
  const selfUpdatable: BridgeUpdateStatus[] = ['updateAvailable', 'updateHeldBack', 'updateRequired', 'unsupported']
  const notSelfUpdatable: BridgeUpdateStatus[] = ['current', 'unknown', 'imageUpdateRequired', 'runnerUpdateRequired']
  for (const status of selfUpdatable) assert.equal(bridgeUpdateSupportsInAppUpdate(status), true, `${status} should self-update`)
  for (const status of notSelfUpdatable) assert.equal(bridgeUpdateSupportsInAppUpdate(status), false, `${status} should not self-update`)
})
