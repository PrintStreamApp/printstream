/**
 * A staged import destined to be a whole OBJECT is normalised to the editor's pivot convention: XY
 * bounding-box centre at the origin, lowest point at z = 0. An instance's `position` places its
 * LOCAL ORIGIN and the rotate gizmo pivots there, so an import left at its file coordinates rotates
 * about whatever point its exporter chose rather than about itself.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeMeshBounds, rebaseImportedMesh } from './mesh-stl.js'
import type { ImportedMesh } from './imported-mesh.js'

/** An axis-aligned box mesh spanning the given corners (triangles omitted: only positions matter). */
function boxMesh(min: [number, number, number], max: [number, number, number]): ImportedMesh {
  const [x0, y0, z0] = min
  const [x1, y1, z1] = max
  const positions = [x0, y0, z0, x1, y0, z0, x1, y1, z1, x0, y1, z1]
  return { positions, indices: [0, 1, 2, 0, 2, 3], bounds: computeMeshBounds(positions) }
}

test('a corner-origin import is centred in XY and floored in Z', () => {
  // The common STL export: every coordinate positive, origin at a corner. Left alone, the object's
  // local origin sits at that corner and the rotate gizmo pivots there.
  const mesh = boxMesh([0, 0, 0], [20, 40, 10])
  const { offset } = rebaseImportedMesh(mesh)

  assert.deepEqual(offset, { x: 10, y: 20, z: 0 })
  assert.deepEqual(mesh.bounds.min, { x: -10, y: -20, z: 0 })
  assert.deepEqual(mesh.bounds.max, { x: 10, y: 20, z: 10 })
})

test('a model centred in XY but running z from zero keeps its floor, and its pivot moves nowhere', () => {
  // The shape behind the reported bug: X and Y already centred, Z running 0..h. Lay it flat (rotate
  // -90 about X) and the un-centred Z becomes an un-centred Y, so the pivot sits at one END rather
  // than at a corner. Z stays FLOORED rather than centred, because the editor rests objects on the
  // bed: the fix for that case is the ROTATION pivot, not a different Z convention.
  const mesh = boxMesh([-15, -25, 0], [15, 25, 8])
  const { offset } = rebaseImportedMesh(mesh)

  assert.deepEqual(offset, { x: 0, y: 0, z: 0 })
  assert.deepEqual(mesh.bounds.min, { x: -15, y: -25, z: 0 })
})

test('an already-centred import is left exactly alone', () => {
  // A 3MF import arrives centred by `recentreParts`, and the cut/split paths by
  // `rebaseTriangleSoup`. Applying this after either must not move anything, or stacking the
  // normalisations would drift the model.
  const mesh = boxMesh([-10, -20, 0], [10, 20, 10])
  const before = [...mesh.positions]
  const { offset } = rebaseImportedMesh(mesh)

  assert.deepEqual(offset, { x: 0, y: 0, z: 0 })
  assert.deepEqual(mesh.positions, before)
})

test('a multi-solid assembly shifts by ONE offset, so its solids keep their relative placement', () => {
  // The trap: rebasing each solid to its own centre collapses an assembly onto itself. The offset
  // comes from the MERGED mesh and every part gets that same shift.
  const left = boxMesh([0, 0, 0], [10, 10, 10])
  const right = boxMesh([90, 0, 0], [100, 10, 10])
  const mesh: ImportedMesh = {
    ...boxMesh([0, 0, 0], [100, 10, 10]),
    parts: [{ name: 'left', mesh: left }, { name: 'right', mesh: right }]
  }

  const { offset } = rebaseImportedMesh(mesh)
  assert.deepEqual(offset, { x: 50, y: 5, z: 0 })
  assert.deepEqual(left.bounds.min, { x: -50, y: -5, z: 0 })
  assert.deepEqual(right.bounds.min, { x: 40, y: -5, z: 0 })
  // 90mm apart before, 90mm apart after.
  assert.equal(right.bounds.min.x - left.bounds.min.x, 90)
})

// The reason this is caller-driven rather than applied by the store. An added PART is centred on
// EVERY axis by `primitivePartSoup` and then placed by that single point inside its host
// (`addedPartDropPosition` drops a helper volume at the host's centre). Flooring its Z would lift it
// half its own height above where the user put it, and a helper volume is translucent and does not
// print, so nothing on screen would say so.
test('a part-shaped soup is unchanged by the object rule only because callers do not apply it', () => {
  const part = boxMesh([-5, -5, -5], [5, 5, 5])
  const { offset } = rebaseImportedMesh(part)

  // Proof of the hazard: the object rule WOULD move an all-axis-centred part up by half its height.
  assert.deepEqual(offset, { x: 0, y: 0, z: -5 })
  assert.deepEqual(part.bounds.min, { x: -5, y: -5, z: 0 })
  assert.deepEqual(part.bounds.max, { x: 5, y: 5, z: 10 })
})
