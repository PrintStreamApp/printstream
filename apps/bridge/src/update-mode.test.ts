/**
 * How the bridge works out its update mode from the new setting, the deprecated pair, or its
 * default, and what it tells the operator along the way.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { legacySettingsForMode, legacyUpdateMode, parseLegacyFlag, resolveBridgeUpdateMode, type BridgeUpdateSettings } from './update-mode.js'

/** Nothing set; each test sets only what it is about. */
function settings(overrides: Partial<BridgeUpdateSettings> = {}): BridgeUpdateSettings {
  return { mode: undefined, legacyAutoUpdate: undefined, legacyDisableSelfUpdate: undefined, ...overrides }
}

test('with nothing set, the default applies and nothing is logged', () => {
  assert.deepEqual(resolveBridgeUpdateMode(settings(), 'automatic'), { mode: 'automatic', notices: [] })
  assert.deepEqual(resolveBridgeUpdateMode(settings(), 'manual'), { mode: 'manual', notices: [] })
})

test('BRIDGE_UPDATE_MODE alone is used as it is, with no notice', () => {
  for (const mode of ['automatic', 'manual', 'pinned'] as const) {
    assert.deepEqual(resolveBridgeUpdateMode(settings({ mode }), 'automatic'), { mode, notices: [] })
  }
})

test('each old setting keeps its meaning and names its replacement', () => {
  const cases = [
    [{ legacyAutoUpdate: true }, 'automatic', 'BRIDGE_AUTO_UPDATE is deprecated; set BRIDGE_UPDATE_MODE=automatic instead.'],
    [{ legacyAutoUpdate: false }, 'manual', 'BRIDGE_AUTO_UPDATE is deprecated; set BRIDGE_UPDATE_MODE=manual instead.'],
    [{ legacyDisableSelfUpdate: true }, 'pinned', 'BRIDGE_DISABLE_SELF_UPDATE is deprecated; set BRIDGE_UPDATE_MODE=pinned instead.']
  ] as const
  for (const [legacy, mode, notice] of cases) {
    assert.deepEqual(resolveBridgeUpdateMode(settings(legacy), 'manual'), { mode, notices: [notice] })
  }
})

test('the old compose example (auto on, pin off) means automatic', () => {
  const result = resolveBridgeUpdateMode(settings({ legacyAutoUpdate: true, legacyDisableSelfUpdate: false }), 'manual')
  assert.equal(result.mode, 'automatic')
  assert.deepEqual(result.notices, [
    'BRIDGE_AUTO_UPDATE and BRIDGE_DISABLE_SELF_UPDATE are deprecated; set BRIDGE_UPDATE_MODE=automatic instead.'
  ])
})

test('an old pin-off on its own leaves the default, and still names the replacement', () => {
  const result = resolveBridgeUpdateMode(settings({ legacyDisableSelfUpdate: false }), 'automatic')
  assert.equal(result.mode, 'automatic')
  assert.deepEqual(result.notices, ['BRIDGE_DISABLE_SELF_UPDATE is deprecated; set BRIDGE_UPDATE_MODE=automatic instead.'])
})

test('automatic and pinned together stay pinned, and the notice says so', () => {
  const result = resolveBridgeUpdateMode(settings({ legacyAutoUpdate: true, legacyDisableSelfUpdate: true }), 'automatic')
  assert.equal(result.mode, 'pinned')
  assert.deepEqual(result.notices, [
    'BRIDGE_AUTO_UPDATE=true and BRIDGE_DISABLE_SELF_UPDATE=true contradict each other; the bridge stays pinned.',
    'BRIDGE_AUTO_UPDATE and BRIDGE_DISABLE_SELF_UPDATE are deprecated; set BRIDGE_UPDATE_MODE=pinned instead.'
  ])
})

test('BRIDGE_UPDATE_MODE wins over the old names, which are reported as ignored', () => {
  const result = resolveBridgeUpdateMode(settings({ mode: 'manual', legacyAutoUpdate: true, legacyDisableSelfUpdate: true }), 'automatic')
  assert.equal(result.mode, 'manual')
  assert.deepEqual(result.notices, [
    'BRIDGE_AUTO_UPDATE and BRIDGE_DISABLE_SELF_UPDATE ignored because BRIDGE_UPDATE_MODE is set; remove them.'
  ])
})

test('old names that agree with BRIDGE_UPDATE_MODE are the rollback copy and log nothing', () => {
  for (const mode of ['automatic', 'manual', 'pinned'] as const) {
    const legacy = legacySettingsForMode(mode)
    const result = resolveBridgeUpdateMode(settings({
      mode,
      legacyAutoUpdate: parseLegacyFlag(legacy.BRIDGE_AUTO_UPDATE),
      legacyDisableSelfUpdate: parseLegacyFlag(legacy.BRIDGE_DISABLE_SELF_UPDATE)
    }), 'manual')
    assert.equal(result.mode, mode)
    assert.deepEqual(result.notices, [], mode)
  }
})

test('the rollback copy means the same mode to a build that reads only the old names', () => {
  for (const mode of ['automatic', 'manual', 'pinned'] as const) {
    const legacy = legacySettingsForMode(mode)
    assert.equal(legacyUpdateMode(parseLegacyFlag(legacy.BRIDGE_AUTO_UPDATE), parseLegacyFlag(legacy.BRIDGE_DISABLE_SELF_UPDATE)), mode)
  }
})

test('an old pin-off beside BRIDGE_UPDATE_MODE contradicts nothing', () => {
  assert.deepEqual(resolveBridgeUpdateMode(settings({ mode: 'automatic', legacyDisableSelfUpdate: false }), 'manual').notices, [])
})
