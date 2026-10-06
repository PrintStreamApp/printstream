import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import type { PaintToolType } from '../editorGeometry'
import type { SupportPaintBrushMode } from './supportPaint'
import type { TrianglePaintChannel } from './threeMfScene'
import { createEditorBrushHover } from './editorBrushHover'

test('brush hover switches among ring, sphere, region, and bed-projected brim ear', () => {
  const scene = new THREE.Scene()
  let regionActive = false
  let regionUpdates = 0
  const regionPreview = {
    get active() { return regionActive },
    clear: () => { regionActive = false },
    update: () => { regionActive = true; regionUpdates += 1 }
  }
  const settings: {
    brimEars: boolean
    channel: TrianglePaintChannel | null
    tool: PaintToolType
    mode: SupportPaintBrushMode
    radius: number
    brimEarDiameter: number
    filamentId: number | null
    filamentColors: Record<number, string> | undefined
  } = {
    brimEars: false,
    channel: 'supports',
    tool: 'circle',
    mode: 'enforcer',
    radius: 4,
    brimEarDiameter: 12,
    filamentId: null,
    filamentColors: undefined
  }
  const hover = createEditorBrushHover({ scene, regionPreview, getSettings: () => settings })
  const ring = scene.children[0] as THREE.Mesh
  const sphere = scene.children[1] as THREE.Mesh
  const hit = { point: new THREE.Vector3(1, 2, 3), normal: new THREE.Vector3(0, 0, 1) }

  hover.update(hit)
  assert.equal(ring.visible, true)
  assert.equal(sphere.visible, false)
  assert.equal(ring.scale.x, 4)
  assert.ok(Math.abs(ring.position.z - 3.05) < 0.001)

  settings.tool = 'sphere'
  hover.update(hit)
  assert.equal(sphere.visible, true)
  assert.equal(ring.visible, false)
  assert.equal(sphere.scale.x, 4)

  settings.tool = 'fill'
  hover.update({ ...hit, mesh: new THREE.Mesh(), faceIndex: 0 })
  assert.equal(regionUpdates, 1)
  assert.equal(ring.visible, false)
  assert.equal(sphere.visible, false)
  assert.equal(hover.visible, true, 'a region overlay is still an active hover')
  hover.clear()
  assert.equal(hover.visible, false)

  settings.brimEars = true
  hover.update(hit)
  assert.equal(ring.visible, true)
  assert.equal(ring.position.z, 0.1)
  assert.equal(ring.scale.x, 6)

  let ringDisposed = false
  ring.geometry.addEventListener('dispose', () => { ringDisposed = true })
  hover.dispose()
  assert.equal(scene.children.length, 0)
  assert.equal(ringDisposed, true)
})
