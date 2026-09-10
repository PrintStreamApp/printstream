/**
 * The OBJ import parser.
 *
 * Focused on the four things a from-scratch reading of the format gets wrong -- negative vertex
 * references, `v/vt/vn` face syntax, n-gon fan triangulation, and trailing vertex-colour fields --
 * plus the refusals, since every one of those failing silently produces a model with a hole in it
 * rather than an error.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseObjMesh } from './mesh-obj.js'
import { ModelImportError } from './imported-mesh.js'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

/** Distinct vertex positions in the parsed mesh, as `x,y,z` keys. */
function positionSet(mesh: { positions: number[]; indices: number[] }): Set<string> {
  const out = new Set<string>()
  for (const index of mesh.indices) {
    out.add(`${mesh.positions[index * 3]},${mesh.positions[index * 3 + 1]},${mesh.positions[index * 3 + 2]}`)
  }
  return out
}

test('a single triangle parses to one welded triangle', () => {
  const mesh = parseObjMesh(encode(['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3'].join('\n')))
  assert.equal(mesh.indices.length, 3)
  assert.equal(mesh.positions.length, 9)
  assert.deepEqual(mesh.bounds, { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } })
})

test('a quad fan-triangulates into two triangles, as BambuStudio does', () => {
  // `num_face_vertices - 2` (OBJ.cpp:89). A quad that produced one triangle would leave a visible
  // hole; one that produced four would double the surface.
  const mesh = parseObjMesh(encode([
    'v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0', 'f 1 2 3 4'
  ].join('\n')))
  assert.equal(mesh.indices.length / 3, 2)
  // Fanned from the first corner, so both triangles share vertex 1 and all four corners appear.
  assert.equal(positionSet(mesh).size, 4)
})

test('negative vertex references count back from the most recent vertex', () => {
  // The reason vertices must be resolved as they are READ rather than gathered first: -1 means the
  // last vertex seen SO FAR, so the same file read in two passes resolves them against a different pool.
  const relative = parseObjMesh(encode(['v 0 0 0', 'v 2 0 0', 'v 0 2 0', 'f -3 -2 -1'].join('\n')))
  const absolute = parseObjMesh(encode(['v 0 0 0', 'v 2 0 0', 'v 0 2 0', 'f 1 2 3'].join('\n')))
  assert.deepEqual(relative.positions, absolute.positions)
  assert.deepEqual(relative.indices, absolute.indices)
})

test('face syntax carrying texture and normal indices reads only the position', () => {
  // `v/vt/vn`, `v//vn` and bare `v` must all resolve to the same geometry: an exporter picks one
  // based on whether it wrote UVs, which has nothing to do with the shape.
  const full = parseObjMesh(encode([
    'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'vt 0 0', 'vn 0 0 1', 'f 1/1/1 2/1/1 3/1/1'
  ].join('\n')))
  const normalsOnly = parseObjMesh(encode([
    'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'vn 0 0 1', 'f 1//1 2//1 3//1'
  ].join('\n')))
  assert.deepEqual(full.positions, normalsOnly.positions)
  assert.deepEqual(full.bounds, normalsOnly.bounds)
})

test('trailing vertex-colour fields are not read as coordinates', () => {
  // `v x y z r g b`. Reading past the third field would treat the red channel as a fourth
  // coordinate and shift every later vertex, which is silent and total.
  const mesh = parseObjMesh(encode([
    'v 0 0 0 1 0 0', 'v 1 0 0 0 1 0', 'v 0 1 0 0 0 1', 'f 1 2 3'
  ].join('\n')))
  assert.deepEqual(mesh.bounds, { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } })
})

test('object and group markers do not split the mesh', () => {
  // BambuStudio builds ONE indexed_triangle_set and never splits on `o`/`g` (OBJ.cpp:94-99): they
  // are material/draw grouping, so splitting would turn a two-material model into two objects.
  const mesh = parseObjMesh(encode([
    'o first', 'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3',
    'g second', 'usemtl red', 'v 0 0 5', 'v 1 0 5', 'v 0 1 5', 'f 4 5 6'
  ].join('\n')))
  assert.equal(mesh.indices.length / 3, 2)
  assert.equal(mesh.parts, undefined, 'an OBJ is one solid, so it reports no parts')
  assert.equal(mesh.bounds.max.z, 5)
})

test('tab-separated fields parse, since OBJ permits any whitespace', () => {
  // Splitting on the first SPACE finds none in a tab-delimited file, so every line is dropped and
  // the parser reports "contained no triangles" -- indistinguishable from a corrupt file.
  const tabbed = parseObjMesh(encode(['v\t0\t0\t0', 'v\t1\t0\t0', 'v\t0\t1\t0', 'f\t1\t2\t3'].join('\n')))
  const spaced = parseObjMesh(encode(['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3'].join('\n')))
  assert.deepEqual(tabbed.positions, spaced.positions)
  assert.deepEqual(tabbed.indices, spaced.indices)
})

test('runs of whitespace and CRLF line endings do not shift the fields', () => {
  const mesh = parseObjMesh(encode(['v   0  0   0', 'v  1 0 0', 'v 0  1 0', 'f  1  2  3'].join('\r\n')))
  assert.equal(mesh.indices.length / 3, 1)
  assert.deepEqual(mesh.bounds, { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } })
})

test('an INLINE comment is stripped, not read as a face corner', () => {
  // `#` starts a comment anywhere on the line. Handling only whole-line comments made a valid
  // `f 1 2 3 # bottom face` parse `#` as a fourth corner, `parseInt` it to NaN, and refuse the
  // WHOLE file as corrupt -- and inconsistently, since the `v` branch reads only its first three
  // fields and tolerated the same trailing text.
  const mesh = parseObjMesh(encode([
    'v 0 0 0  # origin', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0', 'f 1 2 3 # bottom face', 'f 1 3 4'
  ].join('\n')))
  assert.equal(mesh.indices.length / 3, 2)
  assert.deepEqual(mesh.bounds, { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } })
})

test('comments and blank lines are skipped', () => {
  const mesh = parseObjMesh(encode([
    '# exported by something', '', 'v 0 0 0', 'v 1 0 0', '', 'v 0 1 0', '# a face follows', 'f 1 2 3'
  ].join('\n')))
  assert.equal(mesh.indices.length / 3, 1)
})

test('coincident corners are welded away, as every other import is', () => {
  // Two triangles sharing an edge must share their vertices, or the mesh reaches the slicer as
  // index-level soup and small features mis-stitch (see `weldImportedMeshVertices`).
  const mesh = parseObjMesh(encode([
    'v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0', 'f 1 2 3', 'f 1 3 4'
  ].join('\n')))
  assert.equal(mesh.indices.length / 3, 2)
  assert.equal(mesh.positions.length / 3, 4, 'four distinct corners, not six')
})

test('a file with no faces is refused rather than imported empty', () => {
  assert.throws(
    () => parseObjMesh(encode(['v 0 0 0', 'v 1 0 0', 'v 0 1 0'].join('\n'))),
    /contained no triangles/
  )
})

test('a face with fewer than three vertices is fatal, not skipped', () => {
  // BambuStudio refuses the whole file (OBJ.cpp:85-88). Dropping the face instead would leave a
  // hole the user has no way to see.
  assert.throws(
    () => parseObjMesh(encode(['v 0 0 0', 'v 1 0 0', 'f 1 2'].join('\n'))),
    /less than 3 vertices/
  )
})

test('a face naming a vertex that does not exist is refused', () => {
  assert.throws(
    () => parseObjMesh(encode(['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 9'].join('\n'))),
    /invalid vertex index/
  )
})

test('every refusal is a ModelImportError, so the worker can classify by type', () => {
  // A DATA failure must not be retried on the main thread: the same bytes fail the same way and the
  // retry is the frozen tab the worker exists to avoid. `isDataError` asks `instanceof` rather than
  // matching message text, which it used to -- an unlisted wording was silently misclassified, and
  // the pattern was a contract nobody could see from here.
  for (const [label, source] of [
    ['no triangles', ['v 0 0 0'].join('\n')],
    ['short face', ['v 0 0 0', 'v 1 0 0', 'f 1 2'].join('\n')],
    ['bad index', ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 9'].join('\n')],
    ['unreadable coordinates', ['v x y z', 'f 1 1 1'].join('\n')]
  ] as const) {
    const error = (() => { try { parseObjMesh(encode(source)); return null } catch (caught) { return caught } })()
    assert.ok(error instanceof ModelImportError, `${label} must throw a ModelImportError`)
  }
})
