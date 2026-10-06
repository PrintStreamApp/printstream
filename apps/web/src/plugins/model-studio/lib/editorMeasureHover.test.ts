import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import {
  MEASURE_POINT_COLORS,
  MEASURE_POINT_MODE_COLOR,
  SCREEN_SPACE_OVERLAY_KEY
} from '../editorGeometry'
import { createEditorMeasureHover } from './editorMeasureHover'

const point = (x: number) => ({ kind: 'point' as const, point: new THREE.Vector3(x, 0, 0) })

test('measure hover follows the current pick slot and point mode without moving the pointer', () => {
  const scene = new THREE.Scene()
  const first = point(1)
  const second = point(2)
  const pick = { feature: second, source: second }
  let picks: Array<typeof pick> = []
  const hover = createEditorMeasureHover(scene, () => picks)
  const group = scene.children[0] as THREE.Group
  const marker = () => group.children[0] as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>

  assert.equal(group.userData[SCREEN_SPACE_OVERLAY_KEY], true)
  hover.update(pick)
  assert.equal(marker().material.color.getHex(), MEASURE_POINT_COLORS[0])

  const originalMarker = marker()
  hover.update(pick)
  assert.equal(marker(), originalMarker, 'an unchanged hover reuses its geometry')

  picks = [{ feature: first, source: first }]
  hover.update(pick)
  assert.equal(marker().material.color.getHex(), MEASURE_POINT_COLORS[1])
  assert.notEqual(marker(), originalMarker, 'a changed pick slot redraws the highlight')

  hover.update(pick, true)
  assert.equal(marker().material.color.getHex(), MEASURE_POINT_MODE_COLOR)
  assert.equal(hover.source, second)

  hover.clear()
  assert.equal(hover.feature, null)
  assert.equal(group.children.length, 0)
  hover.dispose()
  assert.equal(scene.children.includes(group), false)
})

test('circle hover keeps its rim and centre in the screen-overlay group', () => {
  const scene = new THREE.Scene()
  const hover = createEditorMeasureHover(scene, () => [])
  const group = scene.children[0] as THREE.Group
  const center = new THREE.Vector3(0, 0, 0)
  const circle = {
    kind: 'circle' as const,
    center,
    normal: new THREE.Vector3(0, 0, 1),
    radius: 1,
    rim: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)]
  }

  hover.update({ feature: circle, source: circle })
  assert.equal(group.children.length, 2, 'rim and centre are direct overlay children')
  assert.equal((group.children[0] as THREE.LineLoop).material instanceof THREE.LineBasicMaterial, true)
  assert.equal(((group.children[0] as THREE.LineLoop).material as THREE.LineBasicMaterial).opacity, 0.95)

  hover.update({ feature: point(0), source: circle })
  assert.equal(group.children.length, 2)
  assert.equal(((group.children[0] as THREE.LineLoop).material as THREE.LineBasicMaterial).opacity, 0.35)
  hover.dispose()
})
