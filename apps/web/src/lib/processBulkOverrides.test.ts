/**
 * Pins the bulk (multi-target) per-object override semantics behind the settings dialog's
 * mixed-value handling (issue #84): what seeds as uniform vs "Mixed", what an apply emits, and —
 * the invariant the old replace-with-first-member apply violated — that untouched mixed keys
 * survive an apply with each member's own value intact.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProcessSettingOverrides } from '@printstream/shared'
import {
  applyBulkOverridesToMember,
  collectBulkOverridesResult,
  summarizeBulkOverrides
} from './processBulkOverrides'

test('single member seeds every key uniform, none mixed', () => {
  const seed = summarizeBulkOverrides([{ wall_loops: '3', brim_type: 'no_brim' }])
  assert.deepEqual([...seed.explicitKeys].sort(), ['brim_type', 'wall_loops'])
  assert.equal(seed.mixedKeys.size, 0)
  assert.deepEqual(seed.uniformOverrides, { wall_loops: '3', brim_type: 'no_brim' })
})

test('agreeing members seed uniform; disagreeing values are mixed', () => {
  const seed = summarizeBulkOverrides([
    { wall_loops: '3', brim_type: 'no_brim' },
    { wall_loops: '3', brim_type: 'outer_only' }
  ])
  assert.deepEqual(seed.uniformOverrides, { wall_loops: '3' })
  assert.deepEqual([...seed.mixedKeys], ['brim_type'])
  assert.deepEqual([...seed.explicitKeys].sort(), ['brim_type', 'wall_loops'])
})

test('a key set on only some members is mixed even when the set values agree', () => {
  const seed = summarizeBulkOverrides([{ wall_loops: '3' }, {}])
  assert.deepEqual([...seed.mixedKeys], ['wall_loops'])
  assert.deepEqual(seed.uniformOverrides, {})
})

test('value comparison is option-aware: serialization variants of one value are uniform', () => {
  // A percent option serializes as "20" in a preset JSON and "20%" in a 3MF's project config —
  // the same 20% either way (see processConfigValuesEqual). Raw string comparison would show
  // the user a phantom "Mixed".
  const seed = summarizeBulkOverrides([
    { sparse_infill_density: '20' },
    { sparse_infill_density: '20%' }
  ])
  assert.equal(seed.mixedKeys.size, 0)
  assert.deepEqual(seed.uniformOverrides, { sparse_infill_density: '20' })
})

test('apply emits uniform keys, skips still-mixed keys, and names reset keys as cleared', () => {
  const result = collectBulkOverridesResult({
    // wall_loops uniform-edited, brim_type still mixed, seam_position was reset (left explicit).
    config: { wall_loops: '4', brim_type: 'no_brim', seam_position: 'aligned' },
    explicitKeys: new Set(['wall_loops', 'brim_type']),
    mixedKeys: new Set(['brim_type']),
    initialSetKeys: new Set(['wall_loops', 'brim_type', 'seam_position'])
  })
  assert.deepEqual(result.overrides, { wall_loops: '4' })
  assert.deepEqual(result.clearedKeys, ['seam_position'])
})

test('untouched mixed keys survive an apply with each member keeping its own value', () => {
  const members: ProcessSettingOverrides[] = [
    { wall_loops: '2', brim_type: 'no_brim' },
    { wall_loops: '5', brim_type: 'no_brim' },
    { brim_type: 'outer_only' }
  ]
  const seed = summarizeBulkOverrides(members)
  // Both keys disagree somewhere: wall_loops by value, brim_type by value AND absence.
  assert.deepEqual([...seed.mixedKeys].sort(), ['brim_type', 'wall_loops'])
  // The user edits nothing and hits Apply.
  const result = collectBulkOverridesResult({
    config: {},
    explicitKeys: seed.explicitKeys,
    mixedKeys: seed.mixedKeys,
    initialSetKeys: seed.explicitKeys
  })
  const applied = members.map((member) => applyBulkOverridesToMember(member, result.overrides, result.clearedKeys))
  assert.deepEqual(applied, members)
})

test('merge onto a member assigns uniform values, deletes cleared keys, keeps the rest', () => {
  const merged = applyBulkOverridesToMember(
    { wall_loops: '2', brim_type: 'outer_only', seam_position: 'aligned' },
    { wall_loops: '4' },
    ['seam_position']
  )
  assert.deepEqual(merged, { wall_loops: '4', brim_type: 'outer_only' })
})

test('merge treats an absent member map as empty', () => {
  assert.deepEqual(applyBulkOverridesToMember(undefined, { wall_loops: '4' }, ['brim_type']), { wall_loops: '4' })
})
