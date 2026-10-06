import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { createEditorLitScene, createEditorSceneCamera } from './editorSceneSetup'

test('each editor mount gets a Z-up camera and its own lit plate root', () => {
  const home = new THREE.Vector3(0, -1, 1).normalize()
  const camera = createEditorSceneCamera(800, 400, home)
  assert.equal(camera.aspect, 2)
  assert.deepEqual(camera.up.toArray(), [0, 0, 1])
  assert.ok(camera.position.distanceTo(home.clone().multiplyScalar(360)) < 0.000001)

  const first = createEditorLitScene()
  const second = createEditorLitScene()
  assert.notEqual(first.scene, second.scene)
  assert.notEqual(first.plateRoot, second.plateRoot)
  assert.equal(first.plateRoot.parent, first.scene)
  assert.equal(first.scene.background instanceof THREE.Color, true)
  const shadowLight = first.scene.children.find((child) => child instanceof THREE.DirectionalLight && child.castShadow)
  assert.ok(shadowLight instanceof THREE.DirectionalLight)
  assert.deepEqual([shadowLight.shadow.mapSize.x, shadowLight.shadow.mapSize.y], [2048, 2048])
})
