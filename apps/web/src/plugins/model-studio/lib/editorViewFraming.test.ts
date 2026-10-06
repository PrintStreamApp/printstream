import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { createEditorViewFraming } from './editorViewFraming'
import type { ViewportCameraDestination } from './viewportCamera'
import { VIEW_PRESET_CONFIG } from './viewCube'

test('a normal preset click frames the current bed while Shift preserves the pivot', () => {
  const camera = new THREE.PerspectiveCamera()
  const target = new THREE.Vector3(5, 6, 7)
  const destinations: ViewportCameraDestination[] = []
  const framing = createEditorViewFraming({
    camera,
    orbit: { target, update: () => undefined },
    rig: { swingTo: (destination) => { destinations.push(destination) }, cancel: () => undefined },
    getBedCenter: () => ({ x: 120, y: 130 }),
    getViewDistance: () => 250,
    planeZ: 20,
    homeDirection: new THREE.Vector3(0, -1, 1).normalize()
  })

  framing.applyViewPreset('top')
  assert.deepEqual(destinations[0]?.direction, VIEW_PRESET_CONFIG.top.direction)
  assert.deepEqual(destinations[0]?.target?.toArray(), [120, 130, 20])
  assert.equal(destinations[0]?.distance, 250)

  framing.applyViewDirection(VIEW_PRESET_CONFIG.front.direction, { reframe: false })
  assert.equal(destinations[1]?.target, undefined)
  assert.equal(destinations[1]?.distance, undefined)
  assert.deepEqual(target.toArray(), [5, 6, 7])
})

test('home framing cancels a swing before setting the camera and orbit target', () => {
  const camera = new THREE.PerspectiveCamera()
  const target = new THREE.Vector3()
  const calls: string[] = []
  const framing = createEditorViewFraming({
    camera,
    orbit: { target, update: () => { calls.push('update') } },
    rig: { swingTo: () => undefined, cancel: () => { calls.push('cancel') } },
    getBedCenter: () => ({ x: 10, y: 20 }),
    getViewDistance: () => 100,
    planeZ: 5,
    homeDirection: new THREE.Vector3(0, -1, 0)
  })

  framing.frameDefaultView()
  assert.deepEqual(calls, ['cancel', 'update'])
  assert.deepEqual(target.toArray(), [10, 20, 5])
  assert.deepEqual(camera.position.toArray(), [10, -80, 5])
  assert.deepEqual(camera.up.toArray(), [0, 0, 1])
})
