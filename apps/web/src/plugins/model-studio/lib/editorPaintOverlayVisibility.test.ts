import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { PAINT_CHANNEL_SPECS } from '../editorGeometry'
import type { TrianglePaintChannel } from './threeMfScene'
import { createEditorPaintOverlayVisibility } from './editorPaintOverlayVisibility'

test('paint overlays follow channel, selection, drag, and layer editing without idle traversals', () => {
  const makeOverlay = (channel: TrianglePaintChannel) => {
    const mesh = new THREE.Mesh()
    mesh.name = PAINT_CHANNEL_SPECS[channel].overlayName
    mesh.userData.isPaintOverlay = true
    return mesh
  }
  const selectedGroup = new THREE.Group()
  const selectedSupport = makeOverlay('supports')
  const selectedColor = makeOverlay('color')
  selectedGroup.add(selectedSupport, selectedColor)
  const otherGroup = new THREE.Group()
  const otherSupport = makeOverlay('supports')
  const otherColor = makeOverlay('color')
  otherGroup.add(otherSupport, otherColor)
  const groups = new Map([['selected', selectedGroup], ['other', otherGroup]])
  const state: { activeChannel: TrianglePaintChannel | null; selectedKey: string | null; layersEditing: boolean } = {
    activeChannel: 'supports', selectedKey: 'selected', layersEditing: false
  }
  let traversals = 0
  const visibility = createEditorPaintOverlayVisibility({
    getGroups: () => { traversals += 1; return groups },
    getState: () => state
  })

  visibility.sync(false)
  assert.deepEqual(
    [selectedSupport.visible, selectedColor.visible, otherSupport.visible, otherColor.visible],
    [true, true, false, true]
  )
  visibility.sync(false)
  assert.equal(traversals, 1, 'an unchanged frame skips the scene walk')

  visibility.sync(true)
  assert.deepEqual([selectedSupport.visible, selectedColor.visible, otherColor.visible], [false, false, false])
  visibility.sync(false)
  assert.equal(selectedColor.visible, true)

  state.activeChannel = null
  state.layersEditing = true
  visibility.sync(false)
  assert.equal(selectedColor.visible, false, 'layer shading must not be covered by colour paint')
  state.layersEditing = false
  state.selectedKey = 'other'
  state.activeChannel = 'supports'
  visibility.sync(false)
  assert.deepEqual([selectedSupport.visible, otherSupport.visible, otherColor.visible], [false, true, true])
})
