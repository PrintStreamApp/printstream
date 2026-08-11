/**
 * Pins the multi-selection rigid-body semantics (BambuStudio Selection::rotate /
 * scale_and_translate parity): offsets orbit the pivot, orientations/scales compose, and the
 * mode-keyed pivot (min enclosing sphere for rotate, union-box centre otherwise).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import {
  applySelectionDelta,
  minEnclosingSphereCenter,
  selectionDeltaFromProxy,
  selectionPivot,
  type SelectionDelta,
  type SelectionMemberPose
} from './multiSelectionTransform'

const IDENTITY_POSE = (): SelectionMemberPose => ({
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
  scale: new THREE.Vector3(1, 1, 1)
})

const IDENTITY_DELTA = (): SelectionDelta => ({
  translation: new THREE.Vector3(),
  rotation: new THREE.Quaternion(),
  scale: new THREE.Vector3(1, 1, 1)
})

function assertVectorNear(actual: THREE.Vector3, expected: [number, number, number], tolerance = 1e-6) {
  for (const [axis, value] of (['x', 'y', 'z'] as const).map((key, index) => [actual[key], expected[index]] as const)) {
    assert.ok(Math.abs(axis - (value ?? 0)) < tolerance, `expected ${JSON.stringify(expected)}, got (${actual.x}, ${actual.y}, ${actual.z})`)
  }
}

test('translate applies the same world displacement to every member', () => {
  const delta = { ...IDENTITY_DELTA(), translation: new THREE.Vector3(5, -2, 0) }
  const start = { ...IDENTITY_POSE(), position: new THREE.Vector3(10, 10, 3) }
  const pose = applySelectionDelta('translate', start, delta, new THREE.Vector3(100, 100, 0))
  assertVectorNear(pose.position, [15, 8, 3])
  assert.ok(pose.quaternion.equals(start.quaternion))
})

test('rotate orbits the member offset about the pivot AND composes its orientation', () => {
  const quarterTurn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
  const delta = { ...IDENTITY_DELTA(), rotation: quarterTurn }
  const start = { ...IDENTITY_POSE(), position: new THREE.Vector3(10, 0, 2) }
  const pose = applySelectionDelta('rotate', start, delta, new THREE.Vector3(0, 0, 0))
  // (10,0) about the origin by +90° → (0,10); z rides along untouched.
  assertVectorNear(pose.position, [0, 10, 2])
  const euler = new THREE.Euler().setFromQuaternion(pose.quaternion)
  assert.ok(Math.abs(euler.z - Math.PI / 2) < 1e-6)
})

test('rotate about a non-Z axis is rigid-body too (no Z-only special case)', () => {
  const halfTurnX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI)
  const delta = { ...IDENTITY_DELTA(), rotation: halfTurnX }
  const start = { ...IDENTITY_POSE(), position: new THREE.Vector3(0, 5, 0) }
  const pose = applySelectionDelta('rotate', start, delta, new THREE.Vector3(0, 0, 0))
  assertVectorNear(pose.position, [0, -5, 0])
})

test('scale pushes offsets away from the pivot and composes member scale, per axis', () => {
  const delta = { ...IDENTITY_DELTA(), scale: new THREE.Vector3(2, 1, 1) }
  const start = { ...IDENTITY_POSE(), position: new THREE.Vector3(10, 4, 0), scale: new THREE.Vector3(1, 3, 1) }
  const pose = applySelectionDelta('scale', start, delta, new THREE.Vector3(5, 0, 0))
  // Offset (5,4,0) scales to (10,4,0) → position (15,4,0); member scale x doubles, y keeps its 3.
  assertVectorNear(pose.position, [15, 4, 0])
  assertVectorNear(pose.scale, [2, 3, 1])
})

test('selectionDeltaFromProxy reads the drag delta relative to the proxy start pose', () => {
  const start: SelectionMemberPose = {
    position: new THREE.Vector3(50, 50, 10),
    quaternion: new THREE.Quaternion(),
    scale: new THREE.Vector3(1, 1, 1)
  }
  const current: SelectionMemberPose = {
    position: new THREE.Vector3(53, 50, 10),
    quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 4),
    scale: new THREE.Vector3(2, 2, 2)
  }
  const delta = selectionDeltaFromProxy(current, start)
  assertVectorNear(delta.translation, [3, 0, 0])
  assertVectorNear(delta.scale, [2, 2, 2])
  const euler = new THREE.Euler().setFromQuaternion(delta.rotation)
  assert.ok(Math.abs(euler.z - Math.PI / 4) < 1e-6)
})

test('translate/scale pivot is the union-box centre', () => {
  const boxes = [
    new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 10, 10)),
    new THREE.Box3(new THREE.Vector3(20, 0, 0), new THREE.Vector3(30, 10, 20))
  ]
  assertVectorNear(selectionPivot(boxes, 'translate') as THREE.Vector3, [15, 5, 10])
  assertVectorNear(selectionPivot(boxes, 'scale') as THREE.Vector3, [15, 5, 10])
})

test('rotate pivot is the min-enclosing-sphere centre, not the union-box centre', () => {
  // A big cube with a small antenna box on one face: the antenna sits well inside the cube's
  // own corner sphere, so the min sphere ignores it entirely (centre stays the cube centre)
  // while the union-box centre gets dragged toward the antenna.
  const cube = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 100, 100))
  const antenna = new THREE.Box3(new THREE.Vector3(45, 100, 45), new THREE.Vector3(55, 115, 55))
  const pivot = selectionPivot([cube, antenna], 'rotate') as THREE.Vector3
  assertVectorNear(pivot, [50, 50, 50], 1e-3)
  const unionCenter = new THREE.Box3().union(cube).union(antenna).getCenter(new THREE.Vector3())
  assert.ok(Math.abs(unionCenter.y - 57.5) < 1e-9, 'fixture: union centre must sit off the sphere centre')
})

test('min sphere of two points is their midpoint', () => {
  const center = minEnclosingSphereCenter([new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0)])
  assertVectorNear(center as THREE.Vector3, [5, 0, 0])
})

test('min sphere of an obtuse triangle is the longest side midpoint, not the circumcentre', () => {
  const center = minEnclosingSphereCenter([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(10, 0, 0),
    new THREE.Vector3(5, 0.5, 0)
  ])
  assertVectorNear(center as THREE.Vector3, [5, 0, 0])
})

test('min sphere of cube corners is the cube centre', () => {
  const corners: THREE.Vector3[] = []
  for (const x of [0, 10]) for (const y of [0, 10]) for (const z of [0, 10]) corners.push(new THREE.Vector3(x, y, z))
  assertVectorNear(minEnclosingSphereCenter(corners) as THREE.Vector3, [5, 5, 5], 1e-4)
})

test('min sphere of coplanar square corners is the square centre', () => {
  const center = minEnclosingSphereCenter([
    new THREE.Vector3(0, 0, 5), new THREE.Vector3(10, 0, 5),
    new THREE.Vector3(10, 10, 5), new THREE.Vector3(0, 10, 5)
  ])
  assertVectorNear(center as THREE.Vector3, [5, 5, 5], 1e-4)
})

test('min sphere of two separated cubes spans the far corner pair', () => {
  const corners: THREE.Vector3[] = []
  for (const base of [0, 10]) {
    for (const x of [base, base + 1]) for (const y of [base, base + 1]) for (const z of [base, base + 1]) {
      corners.push(new THREE.Vector3(x, y, z))
    }
  }
  assertVectorNear(minEnclosingSphereCenter(corners) as THREE.Vector3, [5.5, 5.5, 5.5], 1e-4)
})
