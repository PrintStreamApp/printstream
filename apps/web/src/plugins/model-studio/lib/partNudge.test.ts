import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { plateDeltaToPartLocal } from '../editorGeometry'

test('an unrotated object takes the plate delta unchanged', () => {
  const local = plateDeltaToPartLocal(new THREE.Matrix4(), 1, 0)
  assert.ok(Math.abs(local.x - 1) < 1e-9)
  assert.ok(Math.abs(local.y) < 1e-9)
})

test('a 180-degree-rotated object flips the delta, so "right" still moves right on screen', () => {
  // Local -x renders as world +x under the object's 180 rotation. Without the conversion the part
  // took +1 local and visibly moved LEFT — the reported bug.
  const local = plateDeltaToPartLocal(new THREE.Matrix4().makeRotationZ(Math.PI), 1, 0)
  assert.ok(Math.abs(local.x + 1) < 1e-9, `expected -1, got ${local.x}`)
})

test('a scaled object needs a smaller local delta for the same plate distance', () => {
  const local = plateDeltaToPartLocal(new THREE.Matrix4().makeScale(2, 2, 2), 1, 0)
  assert.ok(Math.abs(local.x - 0.5) < 1e-9, `expected 0.5, got ${local.x}`)
})

test('a mirrored object reverses the axis it was mirrored on', () => {
  const local = plateDeltaToPartLocal(new THREE.Matrix4().makeScale(-1, 1, 1), 1, 0)
  assert.ok(Math.abs(local.x + 1) < 1e-9, `expected -1, got ${local.x}`)
})
