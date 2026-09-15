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
import {
  parseObjMaterialColors,
  parseObjMaterials,
  parseObjMesh,
  referencedObjMaterialLibraries,
  resolveObjMaterials
} from './mesh-obj.js'
import { mergeImportedMeshes } from './mesh-stl.js'
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

test('trailing vertex colours stay aligned to face corners', () => {
  // `v x y z r g b`. Reading past the third field would treat the red channel as a fourth
  // coordinate and shift every later vertex, which is silent and total.
  const mesh = parseObjMesh(encode([
    'v 0 0 0 1 0 0', 'v 1 0 0 0 1 0', 'v 0 1 0 0 0 1', 'f 1 2 3'
  ].join('\n')))
  assert.deepEqual(mesh.bounds, { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } })
  assert.deepEqual(mesh.triangleCornerColors, [
    1, 0, 0, 1,
    0, 1, 0, 1,
    0, 0, 1, 1
  ])
})

test('OBJ colour channels clamp like BambuStudio and missing colours remain undefined', () => {
  const mesh = parseObjMesh(encode([
    'v 0 0 0 2 -1 0.5 0.25', 'v 1 0 0', 'v 0 1 0 0 0 1', 'f 1 2 3'
  ].join('\n')))
  assert.deepEqual(mesh.triangleCornerColors, [
    1, 0, 0.5, 0.25,
    0, 0, 0, 0,
    0, 0, 1, 1
  ])
})

test('MTL diffuse colours paint each face through its active material', () => {
  const materials = parseObjMaterialColors(encode([
    'newmtl Signal Red', 'Kd 1.2 -1 0.25',
    'newmtl Glass', 'Kd 0 0.5 1', 'd 0.5'
  ].join('\n')))
  const mesh = parseObjMesh(encode([
    'mtllib palette.mtl',
    'v 0 0 0', 'v 1 0 0', 'v 0 1 0',
    'v 0 0 1', 'v 1 0 1', 'v 0 1 1',
    'usemtl Signal Red', 'f 1 2 3',
    'usemtl Glass', 'f 4 5 6'
  ].join('\n')), { materialColors: materials })

  assert.equal(mesh.sourceColorMode, 'material')
  assert.deepEqual(mesh.triangleCornerColors, [
    1, 0, 0.25, 1, 1, 0, 0.25, 1, 1, 0, 0.25, 1,
    0, 0.5, 1, 0.5, 0, 0.5, 1, 0.5, 0, 0.5, 1, 0.5
  ])
})

test('vertex colours take precedence while MTL fills otherwise-uncoloured corners', () => {
  const materials = parseObjMaterialColors(encode(['newmtl blue', 'Kd 0 0 1'].join('\n')))
  const mesh = parseObjMesh(encode([
    'v 0 0 0 1 0 0', 'v 1 0 0', 'v 0 1 0', 'usemtl blue', 'f 1 2 3'
  ].join('\n')), { materialColors: materials })

  assert.equal(mesh.sourceColorMode, 'vertex')
  assert.deepEqual(mesh.triangleCornerColors, [
    1, 0, 0, 1,
    0, 0, 1, 1,
    0, 0, 1, 1
  ])
})

test('OBJ material-library references are unique and comment-safe', () => {
  assert.deepEqual(referencedObjMaterialLibraries(encode([
    'mtllib primary.mtl accents.mtl # bundled palettes',
    'mtllib primary.mtl'
  ].join('\n'))), ['primary.mtl', 'accents.mtl'])
})

test('a malformed MTL colour is a classified import error', () => {
  assert.throws(
    () => parseObjMaterialColors(encode(['newmtl broken', 'Kd red green blue'].join('\n'))),
    ModelImportError
  )
})

test('MTL texture references retain paths with options and spaces', () => {
  const materials = parseObjMaterials(encode([
    'newmtl shell',
    'Kd 0.2 0.3 0.4',
    'map_Kd -s 1 1 1 textures/Shell Colour.png'
  ].join('\n')))
  assert.deepEqual(materials.get('shell'), {
    color: [0.2, 0.3, 0.4, 1],
    textureName: 'textures/Shell Colour.png'
  })
})

test('OBJ map_Kd textures use independent UV indices and flip the OBJ V axis', async () => {
  const obj = encode([
    'mtllib shell.mtl',
    'v 0 0 0', 'v 1 0 0', 'v 0 1 0',
    'vt 0 1', 'vt 1 1', 'vt 0 0',
    'usemtl shell', 'f 1/3 2/1 3/2'
  ].join('\n'))
  const companions = [
    { name: 'shell.mtl', bytes: encode('newmtl shell\nmap_Kd pixels.png') },
    { name: 'pixels.png', bytes: Uint8Array.of(1) }
  ]
  const materials = await resolveObjMaterials(obj, companions, () => ({
    width: 2,
    height: 2,
    rgba: Uint8Array.from([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 255, 255
    ])
  }))
  const mesh = parseObjMesh(obj, { materials })

  assert.equal(mesh.sourceColorMode, 'texture')
  assert.ok(mesh.indices.length / 3 >= 10_000)
  assert.equal(mesh.triangleCornerColors?.length, mesh.indices.length * 4)
  const colors = new Set<string>()
  for (let offset = 0; offset < mesh.triangleCornerColors!.length; offset += 4) {
    colors.add(mesh.triangleCornerColors!.slice(offset, offset + 3).map((value) => Math.round(value * 16)).join(','))
  }
  assert.ok(colors.size > 4, 'subdivision should retain texture detail beyond the original corners')
})

test('unused material textures are not decoded', async () => {
  const obj = encode([
    'mtllib catalogue.mtl',
    'v 0 0 0', 'v 1 0 0', 'v 0 1 0',
    'usemtl plain', 'f 1 2 3'
  ].join('\n'))
  let decoded = 0
  await resolveObjMaterials(obj, [
    { name: 'catalogue.mtl', bytes: encode('newmtl plain\nKd 1 0 0\nnewmtl unused\nmap_Kd huge.png') },
    { name: 'huge.png', bytes: Uint8Array.of(1) }
  ], () => {
    decoded += 1
    return { width: 1, height: 1, rgba: Uint8Array.of(0, 0, 0, 255) }
  })
  assert.equal(decoded, 0)
})

test('colours stay aligned when welding drops a degenerate triangle', () => {
  const mesh = parseObjMesh(encode([
    'v 0 0 0 1 0 0', 'v 0 0 0 0 1 0', 'v 1 0 0 0 0 1',
    'v 0 1 0 1 1 0', 'f 1 2 3', 'f 1 3 4'
  ].join('\n')))
  assert.equal(mesh.indices.length, 3)
  assert.deepEqual(mesh.triangleCornerColors, [
    1, 0, 0, 1,
    0, 0, 1, 1,
    1, 1, 0, 1
  ])
})

test('mesh merging preserves colours and inserts undefined corners for uncoloured siblings', () => {
  const coloured = parseObjMesh(encode([
    'v 0 0 0 1 0 0', 'v 1 0 0 0 1 0', 'v 0 1 0 0 0 1', 'f 1 2 3'
  ].join('\n')))
  const plain = parseObjMesh(encode([
    'v 0 0 1', 'v 1 0 1', 'v 0 1 1', 'f 1 2 3'
  ].join('\n')))
  const merged = mergeImportedMeshes([plain, coloured])
  assert.equal(merged.triangleCornerColors?.length, merged.indices.length * 4)
  assert.deepEqual(merged.triangleCornerColors?.slice(0, 12), new Array(12).fill(0))
  assert.deepEqual(merged.triangleCornerColors?.slice(12), coloured.triangleCornerColors)
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
