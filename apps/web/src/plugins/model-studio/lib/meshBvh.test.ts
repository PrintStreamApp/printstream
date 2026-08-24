/**
 * The one invariant the paint brush's BVH must not break: it must NOT index the geometry.
 *
 * Every paint mesh here is deliberately non-indexed, because triangle N is addressed as positions
 * 3N..3N+2 by the paint codes, the overlay builder and the 3MF writer alike. `three-mesh-bvh`'s
 * default build calls `ensureIndex`, which does `geometry.setIndex(...)` on a non-indexed geometry;
 * `buildTrianglePaintOverlay` then bails out on sight of `geometry.index` and painting becomes a
 * silent no-op -- the brush runs, state updates, and nothing ever draws.
 *
 * That shipped for one commit. Nothing threw, no type was violated, and a CPU profile even looked
 * BETTER, because the overlay work had stopped happening. Hence a test that asserts the geometry
 * comes back exactly as it went in.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { disposeMeshBvh, ensureMeshBvh } from './meshBvh'

/** A non-indexed mesh, the shape every paintable part mesh has. */
function paintableMesh(triangles = 64): THREE.Mesh {
  const positions = new Float32Array(triangles * 9)
  for (let i = 0; i < triangles; i += 1) {
    const o = i * 9
    positions[o] = i; positions[o + 1] = 0; positions[o + 2] = 0
    positions[o + 3] = i + 1; positions[o + 4] = 0; positions[o + 5] = 0
    positions[o + 6] = i; positions[o + 7] = 1; positions[o + 8] = 0
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
}

test('building a BVH leaves the geometry NON-indexed', () => {
  const mesh = paintableMesh()
  assert.equal(mesh.geometry.index, null, 'fixture should start non-indexed')

  const built = ensureMeshBvh(mesh)

  assert.equal(built, true, 'the tree should build for an ordinary mesh')
  assert.equal(
    mesh.geometry.index,
    null,
    'the BVH indexed the geometry; buildTrianglePaintOverlay refuses an indexed mesh, so painting silently stops drawing'
  )
})

test('the triangle count the paint code addresses is unchanged', () => {
  // Paint keys triangles by position order. If a build reordered or re-indexed vertices, existing
  // paint would land on different facets, which is worse than not drawing at all.
  const mesh = paintableMesh(32)
  const before = mesh.geometry.getAttribute('position').count
  ensureMeshBvh(mesh)
  assert.equal(mesh.geometry.getAttribute('position').count, before)
  assert.equal(before / 3, 32)
})

test('a second call is a no-op rather than a rebuild', () => {
  const mesh = paintableMesh()
  ensureMeshBvh(mesh)
  const tree = (mesh.geometry as THREE.BufferGeometry & { boundsTree?: unknown }).boundsTree
  assert.ok(tree)
  ensureMeshBvh(mesh)
  assert.equal((mesh.geometry as THREE.BufferGeometry & { boundsTree?: unknown }).boundsTree, tree, 'rebuilt on every pointer move')
})

test('a mesh with no position attribute is declined, not thrown on', () => {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  assert.equal(ensureMeshBvh(mesh), false)
})

test('disposal releases the tree so it cannot outlive the geometry', () => {
  const mesh = paintableMesh()
  ensureMeshBvh(mesh)
  disposeMeshBvh(mesh.geometry)
  assert.ok(!(mesh.geometry as THREE.BufferGeometry & { boundsTree?: unknown }).boundsTree)
})
