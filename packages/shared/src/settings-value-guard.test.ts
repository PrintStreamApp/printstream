/**
 * An empty numeric override is not a small mistake. BambuStudio's scalar deserialisers fail on `""`
 * (`Config.hpp:842-848`), `set_deserialize` turns that into a throw (`Config.cpp:573-577`), and the
 * throw unwinds the whole key loop into a generic catch (`Config.cpp:1135-1139`) that abandons every
 * key it had not yet applied. Since the keys are walked in order, one cleared field silently deletes
 * an arbitrary alphabetical tail of the user's settings, and nothing is reported anywhere.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dropEngineHostileOverrides, isEngineHostileValue } from './settings-value-guard'
import { processSettingsCatalog } from './process-settings'

/** A real key of each shape, so the test breaks if the catalog stops carrying them. */
function keyOfType(type: string): string {
  const found = Object.entries(processSettingsCatalog.options).find(
    ([, option]) => option.type === type && option.vector !== true
  )
  assert.ok(found, `the catalog has no scalar ${type} option to test with`)
  return found[0]
}

test('a cleared numeric field is refused', () => {
  for (const type of ['int', 'float', 'percent', 'floatOrPercent']) {
    const key = keyOfType(type)
    assert.equal(isEngineHostileValue(key, ''), true, `${type} (${key}) was allowed through`)
    assert.equal(isEngineHostileValue(key, '   '), true, `whitespace-only ${type} was allowed through`)
  }
})

test('a real numeric value passes', () => {
  assert.equal(isEngineHostileValue(keyOfType('float'), '0.2'), false)
  // Zero is a legitimate value and must not be mistaken for "empty".
  assert.equal(isEngineHostileValue(keyOfType('float'), '0'), false)
})

test('an empty STRING setting is legitimate and passes', () => {
  // `ConfigOptionString` accepts it, and clearing a custom gcode field is a real edit. Dropping
  // every empty value regardless of type would silently refuse it.
  assert.equal(isEngineHostileValue(keyOfType('string'), ''), false)
})

test('an unknown key passes rather than being dropped', () => {
  // The catalogs are scoped to what their dialogs expose, so refusing what we cannot classify would
  // drop overrides for keys that are perfectly fine.
  assert.equal(isEngineHostileValue('not_a_real_setting_key', ''), false)
})

test('a vector value passes', () => {
  // Vectors serialise as [] and deserialise to an empty vector without failing.
  assert.equal(isEngineHostileValue(keyOfType('float'), []), false)
})

test('dropping returns the same object when nothing is hostile', () => {
  const overrides = { [keyOfType('float')]: '0.2' }
  assert.equal(dropEngineHostileOverrides(overrides), overrides)
})

test('dropping removes only the cleared key and keeps the rest', () => {
  const cleared = keyOfType('float')
  const kept = keyOfType('string')
  const out = dropEngineHostileOverrides({ [cleared]: '', [kept]: 'value' })
  assert.deepEqual(Object.keys(out), [kept])
})

/**
 * A `%` in one of the legacy-percent keys makes `handle_legacy` erase the key outright
 * (`PrintConfig.cpp:6945-6955`), and the value then falls back to `FullPrintConfig::defaults()`
 * rather than to the printer's preset, because a 3MF's project config is flat. On a machine whose
 * preset says 200+ mm/s, `outer_wall_speed` lands on 60. Nothing tells the user, and our own dialog
 * keeps showing the typed value, so both sides disagree with the engine in silence.
 *
 * These five speed keys are VECTORS, which our settings dialog renders as free text precisely
 * because a vector packs several values into one string. That is how a `%` gets in.
 */
test('a percent in a key the engine erases is refused', () => {
  assert.equal(isEngineHostileValue('outer_wall_speed', '60%'), true)
  assert.equal(isEngineHostileValue('top_surface_speed', ['50%', '60']), true, 'a vector element was not inspected')
  assert.equal(isEngineHostileValue('initial_layer_speed', '30%'), true)
})

test('an absolute value for the same key passes', () => {
  assert.equal(isEngineHostileValue('outer_wall_speed', '60'), false)
  assert.equal(isEngineHostileValue('outer_wall_speed', ['200', '200']), false)
})

test('a percent in a key that legitimately takes one still passes', () => {
  // Only the seven keys the engine names are affected; percent-typed options elsewhere are normal.
  const percentKey = Object.entries(processSettingsCatalog.options).find(([key, option]) =>
    option.type === 'percent' && !PERCENT_ERASED.has(key))?.[0]
  assert.ok(percentKey, 'the catalog has no ordinary percent option to test with')
  assert.equal(isEngineHostileValue(percentKey, '80%'), false)
})

/** The engine's list, restated here so the test fails if the guard's copy drifts from it. */
const PERCENT_ERASED = new Set([
  'initial_layer_print_height', 'initial_layer_speed', 'internal_solid_infill_speed',
  'top_surface_speed', 'support_interface_speed', 'outer_wall_speed', 'support_object_xy_distance'
])

test('dropping removes a percent override and keeps the rest', () => {
  const out = dropEngineHostileOverrides({ outer_wall_speed: '60%', top_surface_speed: '100' })
  assert.deepEqual(Object.keys(out), ['top_surface_speed'])
})

test('a cleared element of a VECTOR numeric is refused', () => {
  // Found by adversarial review. The dialog writes into element 0 of the resolved config, so
  // clearing the box sends ["", "200"] on a multi-extruder machine and a bare "" on a
  // single-extruder one. The engine refuses neither: ConfigOptionFloatsTempl::deserialize returns
  // true regardless (`Config.hpp:917-937`), so the first becomes a silent 0 and the second a
  // ZERO-LENGTH per-extruder vector whose get_at then reads out of bounds in a release build.
  assert.equal(isEngineHostileValue('outer_wall_speed', ['', '200']), true)
  assert.equal(isEngineHostileValue('outer_wall_speed', ''), true)
  assert.equal(isEngineHostileValue('outer_wall_speed', ['200', '200']), false)
})
