/**
 * The by-object skirt-collision warning, and the one thing that makes it worth sharing.
 *
 * BambuStudio asks this question in two places whose SEQUENCE sources differ: the process tab reads
 * `print_sequence` out of the config in front of it, while the plate dialog resolves the plate's
 * EFFECTIVE sequence, falling back to the global. Getting that fallback wrong drops the commonest
 * case entirely (most plates inherit), and does so silently, since the warning simply never appears.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  plateSkirtCollisionRisk,
  skirtCanCollideWithByObjectPrinting,
  validateProcessConfig
} from './process-settings.js'

/** A multi-layer skirt: the configuration the collision is about. */
const RISKY_SKIRT = { skirt_height: '3', skirt_loops: '2' }

test('a plate explicitly set to by object warns when the skirt is multi-layer', () => {
  assert.equal(plateSkirtCollisionRisk('by object', RISKY_SKIRT), true)
})

test('a plate inheriting a by-object PROJECT warns too', () => {
  // The case a plate's own value cannot answer, and the reason this takes the global config at all.
  // "Same as global" is what a plate says by default, so reading only the override would mean the
  // warning almost never fires.
  assert.equal(plateSkirtCollisionRisk(null, { ...RISKY_SKIRT, print_sequence: 'by object' }), true)
  assert.equal(plateSkirtCollisionRisk(undefined, { ...RISKY_SKIRT, print_sequence: 'by object' }), true)
})

test('a plate that overrides a by-object project back to by layer does not warn', () => {
  // The override wins over the global, in both directions.
  assert.equal(plateSkirtCollisionRisk('by layer', { ...RISKY_SKIRT, print_sequence: 'by object' }), false)
})

test('by-layer printing never warns, however the skirt is configured', () => {
  assert.equal(plateSkirtCollisionRisk('by layer', RISKY_SKIRT), false)
  assert.equal(plateSkirtCollisionRisk(null, { ...RISKY_SKIRT, print_sequence: 'by layer' }), false)
  // Absent print_sequence is by layer, which is the engine's own default.
  assert.equal(plateSkirtCollisionRisk(null, RISKY_SKIRT), false)
})

test('a single-layer skirt or no loops is not a collision risk', () => {
  // Both thresholds matter: one layer is laid before anything is tall enough to hit, and zero
  // loops means there is no skirt at all.
  assert.equal(plateSkirtCollisionRisk('by object', { skirt_height: '1', skirt_loops: '2' }), false)
  assert.equal(plateSkirtCollisionRisk('by object', { skirt_height: '3', skirt_loops: '0' }), false)
  assert.equal(plateSkirtCollisionRisk('by object', {}), false)
})

test('the plate check and the process tab share one skirt rule', () => {
  // They are separate call sites in the engine and were separate here; this pins that the shared
  // half agrees, so a change to the thresholds cannot fix one surface and leave the other.
  const config = { ...RISKY_SKIRT, print_sequence: 'by object' }
  assert.equal(skirtCanCollideWithByObjectPrinting(config), true)
  assert.equal(plateSkirtCollisionRisk(null, config), true)
  assert.ok(
    validateProcessConfig(config).some((issue) => issue.key === 'skirt_height'),
    'the process tab still raises its auto-fixable correction from the same predicate'
  )
})

test('the process tab AUTO-FIXES where the plate dialog only advises', () => {
  // A deliberate asymmetry copied from the engine: the plate dialog must not silently rewrite a
  // project-wide process setting the user did not open.
  const issue = validateProcessConfig({ ...RISKY_SKIRT, print_sequence: 'by object' })
    .find((candidate) => candidate.key === 'skirt_height')
  assert.deepEqual(issue?.fix, { skirt_height: '1' })
})
