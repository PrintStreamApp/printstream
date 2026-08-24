/**
 * A grounded part's edge outline must not cost a second copy of its mesh.
 *
 * `createThreeMfPartObject` already clones the caller's geometry once (it computes bounds on it and
 * hands it to the mesh). The edge outline used to clone it AGAIN just to feed `EdgesGeometry`, which
 * is unnecessary twice over: three's constructor only reads `getIndex()` / `getAttribute('position')`
 * and computes the whole edge list eagerly, and it then keeps whatever it was given in
 * `parameters.geometry` -- so the throwaway copy was retained for the life of the scene, once per
 * part. On an 18 MB, 7-plate project `EdgesGeometry` was 8.9% of all non-idle CPU during the open.
 *
 * Nothing type-checks a stray `.clone()`, and the symptom is invisible (slower opens, more memory,
 * identical pixels), so the identity is pinned here.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { createThreeMfPartObject } from './threeMfScene'

/** A part sitting ON the bed, which is what makes the edge outline render at all. */
function groundedPartGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(10, 10, 10).toNonIndexed()
  geometry.translate(0, 0, 5) // min z = 0: grounded, so `hasBedClearance` is false
  return geometry
}

function edgeLinesOf(group: THREE.Object3D): THREE.LineSegments | null {
  let found: THREE.LineSegments | null = null
  group.traverse((child) => { if ((child as THREE.LineSegments).isLineSegments) found = child as THREE.LineSegments })
  return found
}

function meshOf(group: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null
  group.traverse((child) => { if ((child as THREE.Mesh).isMesh) found = child as THREE.Mesh })
  return found
}

test('the edge outline reuses the part geometry instead of copying it', () => {
  const group = createThreeMfPartObject(groundedPartGeometry(), { color: '#ff0000' })
  const edges = edgeLinesOf(group)
  const mesh = meshOf(group)

  assert.ok(edges, 'a grounded part should get an edge outline')
  assert.ok(mesh, 'a grounded part should get a mesh')

  const source = (edges.geometry as THREE.BufferGeometry & { parameters?: { geometry?: THREE.BufferGeometry } }).parameters?.geometry
  assert.equal(
    source,
    mesh.geometry,
    'EdgesGeometry was handed a copy; it retains its input in parameters.geometry, so every part keeps a second copy of its mesh for the life of the scene'
  )
})

test('the outline still describes the part', () => {
  // Guards the obvious way to "fix" the above: passing no geometry at all.
  const group = createThreeMfPartObject(groundedPartGeometry(), { color: '#ff0000' })
  const edges = edgeLinesOf(group)
  assert.ok(edges)
  const position = edges.geometry.getAttribute('position')
  assert.ok(position && position.count > 0, 'the edge outline has no vertices')
})
