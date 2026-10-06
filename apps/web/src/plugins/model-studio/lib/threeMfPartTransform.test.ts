import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { threeMfTransformFromMatrix } from './threeMfScene'
import { decomposeThreeMfPartTransform } from './threeMfPartTransform'

test('a saved part keeps rotated non-uniform scale and translation during tool re-editing', () => {
  const position = new THREE.Vector3(10, 20, 30)
  const rotation = new THREE.Euler(0.2, -0.4, 0.7)
  const scale = new THREE.Vector3(2, 3, 4)
  const original = new THREE.Matrix4().compose(
    position,
    new THREE.Quaternion().setFromEuler(rotation),
    scale
  )

  const retained = decomposeThreeMfPartTransform(threeMfTransformFromMatrix(original))
  const recomposed = new THREE.Matrix4().compose(
    retained.position,
    new THREE.Quaternion().setFromEuler(retained.rotation),
    retained.scale
  )

  for (let i = 0; i < 16; i += 1) {
    assert.ok(Math.abs(recomposed.elements[i]! - original.elements[i]!) < 0.000001)
  }
  assert.deepEqual(retained.position.toArray(), [10, 20, 30])
})
