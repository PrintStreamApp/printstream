/**
 * World-bounds math for the editor viewport. The one thing worth pinning here is that scaling a
 * placed object is NOT just a multiply: `position` places the object's local ORIGIN, and a Bambu
 * mesh routinely carries plate coordinates in its vertices, so an unguarded scale walks the model
 * away from where it was by `(factor - 1)` times its whole origin-to-centroid offset. At the 25.4x
 * of an inch conversion that is metres.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import {
  BRIM_EAR_MARKER_NAME,
  buildFaceHullOverlay,
  isHiddenInPlateThumbnail,
  isViewportAidMesh,
  printableMeshBox,
  scaleGroupAboutPoint
} from './editorGeometry'

/**
 * A group holding a 10mm cube whose geometry sits `offset` away from the group's own origin,
 * standing in for a mesh exported in plate coordinates.
 */
function cubeGroup(offset: { x: number; y: number; z: number }): THREE.Group {
  const geometry = new THREE.BoxGeometry(10, 10, 10)
  geometry.translate(offset.x, offset.y, offset.z)
  const group = new THREE.Group()
  group.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()))
  return group
}

test('scaling grows an object about its own footprint centre, not its local origin', () => {
  // Geometry centred 100mm from the origin: the trap case. A bare `scale.multiplyScalar(2)` would
  // move the rendered centre from 100 to 200.
  const group = cubeGroup({ x: 100, y: 0, z: 5 })
  const before = printableMeshBox(group)
  const centreBefore = before.getCenter(new THREE.Vector3())

  scaleGroupAboutPoint(group, 2)

  const after = printableMeshBox(group)
  const centreAfter = after.getCenter(new THREE.Vector3())
  assert.ok(Math.abs(centreAfter.x - centreBefore.x) < 1e-6, `X centre moved: ${centreBefore.x} -> ${centreAfter.x}`)
  assert.ok(Math.abs(centreAfter.y - centreBefore.y) < 1e-6, `Y centre moved: ${centreBefore.y} -> ${centreAfter.y}`)
  const size = after.getSize(new THREE.Vector3())
  assert.ok(Math.abs(size.x - 20) < 1e-6, `expected a 20mm cube, got ${size.x}`)
})

test('a scaled object is left resting on the bed, never floating or sunk', () => {
  const group = cubeGroup({ x: 0, y: 0, z: 5 })
  scaleGroupAboutPoint(group, 3)
  const box = printableMeshBox(group)
  assert.ok(Math.abs(box.min.z) < 1e-6, `expected to rest at z=0, got ${box.min.z}`)
  assert.ok(Math.abs(box.getSize(new THREE.Vector3()).z - 30) < 1e-6)
})

test('an explicit pivot pins the footprint centre to that world point', () => {
  // What "scale to print volume" needs: grow, then land on the plate centre.
  const group = cubeGroup({ x: 100, y: -40, z: 5 })
  scaleGroupAboutPoint(group, 0.5, { x: 0, y: 0 })
  const centre = printableMeshBox(group).getCenter(new THREE.Vector3())
  assert.ok(Math.abs(centre.x) < 1e-6, `expected x=0, got ${centre.x}`)
  assert.ok(Math.abs(centre.y) < 1e-6, `expected y=0, got ${centre.y}`)
})

test('scaling composes with an existing rotation rather than fighting it', () => {
  // A rotated object's world AABB is not its local box; the correction has to be measured after
  // the scale, in world space, or a rotated model drifts.
  const group = cubeGroup({ x: 60, y: 0, z: 5 })
  group.rotation.z = Math.PI / 4
  group.updateMatrixWorld(true)
  const centreBefore = printableMeshBox(group).getCenter(new THREE.Vector3())

  scaleGroupAboutPoint(group, 2)

  const centreAfter = printableMeshBox(group).getCenter(new THREE.Vector3())
  assert.ok(Math.abs(centreAfter.x - centreBefore.x) < 1e-6, `X drifted: ${centreBefore.x} -> ${centreAfter.x}`)
  assert.ok(Math.abs(centreAfter.y - centreBefore.y) < 1e-6, `Y drifted: ${centreBefore.y} -> ${centreAfter.y}`)
})

test('an object with no printable geometry is left alone rather than thrown at the origin', () => {
  // Helper volumes are excluded from `printableMeshBox`, so a group of only aids has an empty box.
  const group = new THREE.Group()
  const helper = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 5), new THREE.MeshBasicMaterial())
  helper.userData.isHelperVolume = true
  group.add(helper)
  group.position.set(7, 8, 9)

  scaleGroupAboutPoint(group, 25.4)

  assert.deepEqual(
    [group.position.x, group.position.y, group.position.z, group.scale.x],
    [7, 8, 9, 1],
    'a group with nothing printable was moved or scaled'
  )
})

/** An aid tagged the way its own builder tags it, so a renamed flag fails these rather than passing. */
function taggedAid(userData: Record<string, unknown>, name = ''): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
  Object.assign(mesh.userData, userData)
  mesh.name = name
  return mesh
}

// The regression: the lay-flat click regenerates the plate thumbnail while the place-on-face hull is
// still parented to the instance group, so a thumbnail rule that does not know the hull bakes it
// into the tile as blue patches over the model. Built through the real builder, not a hand-set flag.
test('the place-on-face hull is kept out of a plate thumbnail', () => {
  const hull = buildFaceHullOverlay(cubeGroup({ x: 0, y: 0, z: 5 }))
  assert.ok(hull, 'expected a hull over a cube')
  assert.equal(isHiddenInPlateThumbnail(hull), true)
})

test('a plate thumbnail hides the bed and every viewport aid', () => {
  for (const aid of [
    taggedAid({ isBedSurface: true }),
    taggedAid({ isHelperVolume: true }),
    taggedAid({ isPrimeTower: true }),
    taggedAid({ isLayerHeightVisual: true }),
    taggedAid({}, BRIM_EAR_MARKER_NAME)
  ]) {
    assert.equal(isHiddenInPlateThumbnail(aid), true, `${aid.name || JSON.stringify(aid.userData)} reached the thumbnail`)
  }
})

// Deliberate exception, not an oversight: for the colour channel the paint overlay IS what the
// object prints like, which is the whole point of the tile.
test('a plate thumbnail keeps the paint overlay and the model itself', () => {
  assert.equal(isHiddenInPlateThumbnail(taggedAid({ isPaintOverlay: true })), false)
  assert.equal(isHiddenInPlateThumbnail(taggedAid({})), false)
})

test('an aid tagged on a group root is recognised, not just its meshes', () => {
  // The prime tower and helper volumes tag the GROUP; `visible` is inherited, so hiding the root is
  // what a caller wants, and the predicate has to accept one.
  const tower = new THREE.Group()
  tower.userData.isPrimeTower = true
  assert.equal(isViewportAidMesh(tower), true)
  assert.equal(isHiddenInPlateThumbnail(tower), true)
})
