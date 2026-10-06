import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyEditorHeightRangeSettings } from './editorHeightRangeSettings'
import type { EditorHeightRange } from './editorModel'

test('range settings replace tunable keys while preserving the inline layer and material', () => {
  const ranges: EditorHeightRange[] = [
    { minZ: 0, maxZ: 5, settings: { layer_height: '0.16', speed: '40' } },
    { minZ: 5, maxZ: 10, settings: { layer_height: '0.2', extruder: '3', old: 'source' } }
  ]

  const applied = applyEditorHeightRangeSettings(ranges, 1, { speed: ['10', '20'] }, 0.24)

  assert.equal(applied[0], ranges[0])
  assert.deepEqual(applied[1]?.settings, {
    speed: '10;20',
    layer_height: '0.2',
    extruder: '3'
  })
  assert.deepEqual(ranges[1]?.settings, { layer_height: '0.2', extruder: '3', old: 'source' })
})

test('range settings supply required inline defaults when the source band lacks them', () => {
  const ranges: EditorHeightRange[] = [
    { minZ: 0, maxZ: 10, settings: { speed: '40' } }
  ]

  const applied = applyEditorHeightRangeSettings(ranges, 0, {}, 0.28)

  assert.deepEqual(applied[0]?.settings, { layer_height: '0.28', extruder: '0' })
})
