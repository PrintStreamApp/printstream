import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  defaultEditorLayerHeightMm,
  editorLayerHeightBounds,
  firstEditorLayerHeightMm
} from './editorLayerHeightSettings'

test('process heights seed new ranges and the exact first layer', () => {
  const overrides = { layer_height: '0.16', initial_layer_print_height: ['0.22'] }
  assert.equal(defaultEditorLayerHeightMm(overrides), 0.16)
  assert.equal(firstEditorLayerHeightMm(overrides, 0.16), 0.22)
  assert.equal(defaultEditorLayerHeightMm({ layer_height: '0' }), 0.2)
  assert.equal(firstEditorLayerHeightMm({ initial_layer_print_height: '-1' }, 0.16), 0.16)
})

test('machine band wins over nozzle defaults and rejects malformed limits', () => {
  const stated = { min: 0.08, max: 0.28 }
  assert.equal(editorLayerHeightBounds(stated, '0.6'), stated)
  for (const [limits, nozzle] of [
    [null, '0.4'],
    [{ min: 0.3, max: 0.2 }, '0.4'],
    [{ min: 0.07, max: Number.POSITIVE_INFINITY }, '0.4'],
    [null, '-0.4']
  ] as const) {
    const bounds = editorLayerHeightBounds(limits, nozzle)
    assert.equal(bounds.min, 0.07)
    assert.ok(Math.abs(bounds.max - 0.3) < 1e-10)
  }
})
