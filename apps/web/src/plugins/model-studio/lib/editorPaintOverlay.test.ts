import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { PAINT_CHANNEL_SPECS } from '../editorGeometry'
import { attachEditorPaintOverlay, effectiveEditorPaintCodes } from './editorPaintOverlay'
import { seedEmptyEditorState } from './editorModel'
import type { PaintOverlayCache } from './supportPaint'

function paintedMesh(): THREE.Mesh {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,
    10, 0, 0,
    0, 10, 0
  ], 3))
  return new THREE.Mesh(geometry)
}

test('scene seed and brush refresh share channel naming, cache, and initial visibility', () => {
  const mesh = paintedMesh()
  const cache: PaintOverlayCache = new Map()
  const hidden = attachEditorPaintOverlay(mesh, 'supports', { 0: '4' }, {
    activeChannel: null,
    selected: true,
    colorForState: () => null,
    cache
  })
  assert.ok(hidden)
  assert.equal(hidden.name, PAINT_CHANNEL_SPECS.supports.overlayName)
  assert.equal(hidden.visible, false)
  assert.equal(mesh.children[0], hidden)
  assert.equal(cache.size, 1)

  const color = attachEditorPaintOverlay(mesh, 'color', { 0: '4' }, {
    activeChannel: null,
    selected: false,
    colorForState: () => 0xff0000
  })
  assert.ok(color)
  assert.equal(color.visible, true, 'printed colour stays visible outside its paint tool')
  assert.equal(color.name, PAINT_CHANNEL_SPECS.color.overlayName)
})

test('empty or unrenderable paint leaves the mesh untouched', () => {
  const mesh = paintedMesh()
  const options = { activeChannel: null, selected: false, colorForState: () => null }
  assert.equal(attachEditorPaintOverlay(mesh, 'seam', null, options), null)
  assert.equal(attachEditorPaintOverlay(mesh, 'seam', {}, options), null)
  assert.equal(mesh.children.length, 0)
})

test('a session paint override, including an explicit clear, wins over source paint', () => {
  const mesh = paintedMesh()
  mesh.geometry.userData.supportPaint = { 0: '4' }
  const state = seedEmptyEditorState()
  assert.deepEqual(effectiveEditorPaintCodes(mesh, 'object:1', 'supports', state), { 0: '4' })

  state.supportPaint = { 'object:1': { 0: '8' } }
  assert.deepEqual(effectiveEditorPaintCodes(mesh, 'object:1', 'supports', state), { 0: '8' })

  state.supportPaint['object:1'] = {}
  assert.equal(effectiveEditorPaintCodes(mesh, 'object:1', 'supports', state), null)
})
