import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STEP_TESSELLATION, detectImportFormat, meshToBinaryStl, parseStlMesh, weldImportedMeshVertices } from './mesh-import.js'

/** Build a minimal binary STL containing the given triangles (each 3 xyz vertices). */
function buildBinaryStl(triangles: number[][][]): Buffer {
  const buffer = Buffer.alloc(84 + triangles.length * 50)
  buffer.writeUInt32LE(triangles.length, 80)
  let offset = 84
  for (const triangle of triangles) {
    offset += 12 // normal
    for (const vertex of triangle) {
      buffer.writeFloatLE(vertex[0] ?? 0, offset)
      buffer.writeFloatLE(vertex[1] ?? 0, offset + 4)
      buffer.writeFloatLE(vertex[2] ?? 0, offset + 8)
      offset += 12
    }
    offset += 2
  }
  return buffer
}

test('detectImportFormat recognizes supported extensions', () => {
  assert.equal(detectImportFormat('part.stl'), 'stl')
  assert.equal(detectImportFormat('PART.STL'), 'stl')
  assert.equal(detectImportFormat('assembly.step'), 'step')
  assert.equal(detectImportFormat('assembly.stp'), 'step')
  assert.equal(detectImportFormat('project.3mf'), '3mf')
  assert.equal(detectImportFormat('notes.txt'), null)
})

test('STEP tessellation quality matches BambuStudio defaults', () => {
  // BambuStudio meshes STEP with an absolute 0.003mm chord error + 0.5 rad angular deflection
  // (load_step defaults in src/libslic3r/Format/STEP). occt loads STEP already scaled to mm, so
  // an absolute_value deflection of 0.003 applies the same chord error. Reverting to occt's
  // null-params default (a 0.001 bounding-box ratio) re-introduces faceted curves — guard it.
  assert.equal(STEP_TESSELLATION.linearUnit, 'millimeter')
  assert.equal(STEP_TESSELLATION.linearDeflectionType, 'absolute_value')
  assert.equal(STEP_TESSELLATION.linearDeflection, 0.003)
  assert.equal(STEP_TESSELLATION.angularDeflection, 0.5)
})

test('parseStlMesh reads binary STL triangles and computes bounds', () => {
  const stl = buildBinaryStl([
    [[0, 0, 0], [10, 0, 0], [0, 10, 0]],
    [[0, 0, 5], [10, 0, 5], [0, 10, 5]]
  ])
  const mesh = parseStlMesh(stl)
  assert.equal(mesh.indices.length, 6)
  assert.equal(mesh.positions.length, 18)
  assert.deepEqual(mesh.bounds.min, { x: 0, y: 0, z: 0 })
  assert.deepEqual(mesh.bounds.max, { x: 10, y: 10, z: 5 })
})

test('parseStlMesh reads ASCII STL', () => {
  const ascii = [
    'solid test',
    '  facet normal 0 0 1',
    '    outer loop',
    '      vertex 0 0 0',
    '      vertex 1 0 0',
    '      vertex 0 1 0',
    '    endloop',
    '  endfacet',
    'endsolid test'
  ].join('\n')
  const mesh = parseStlMesh(Buffer.from(ascii, 'utf8'))
  assert.equal(mesh.indices.length, 3)
  assert.deepEqual(mesh.bounds.max, { x: 1, y: 1, z: 0 })
})

test('meshToBinaryStl round-trips through parseStlMesh', () => {
  const original = parseStlMesh(buildBinaryStl([[[1, 2, 3], [4, 5, 6], [7, 8, 9]]]))
  const reparsed = parseStlMesh(meshToBinaryStl(original))
  assert.equal(reparsed.indices.length, 3)
  assert.deepEqual(reparsed.bounds, original.bounds)
})

test('parseStlMesh welds shared vertices into indexed geometry', () => {
  // Two triangles sharing the edge (10,0,0)-(0,10,0): 6 soup corners, 4 real vertices.
  // Unwelded meshes reach the 3MF as index-level triangle soup, which BambuStudio's
  // index-based contour chaining mangles (small inlaid features slice broken).
  const stl = buildBinaryStl([
    [[0, 0, 0], [10, 0, 0], [0, 10, 0]],
    [[10, 0, 0], [10, 10, 0], [0, 10, 0]]
  ])
  const mesh = parseStlMesh(stl)
  assert.equal(mesh.positions.length, 4 * 3)
  assert.equal(mesh.indices.length, 6)
  // Shared corners reference the same vertex index in both triangles.
  assert.equal(mesh.indices[1], mesh.indices[3])
  assert.equal(mesh.indices[2], mesh.indices[5])
})

test('weldImportedMeshVertices drops triangles degenerate after welding', () => {
  const mesh = weldImportedMeshVertices({
    positions: [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2, 0, 2, 3],
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } }
  })
  assert.equal(mesh.positions.length, 3 * 3)
  assert.deepEqual(mesh.indices, [0, 1, 2])
})

/**
 * THE IMPORT PAINT CONTRACT. Triangle painting stores codes by triangle INDEX, so the mesh the
 * editor renders and the mesh the bake writes must agree on triangle order exactly — otherwise
 * painting an import marks the wrong facets, silently and without any error.
 *
 * Both sides read the stored `ImportedMesh.indices` in the same order: `meshToBinaryStl` (what the
 * editor loads through `/mesh`) and `renderImportedMeshObjectXml` (what the bake writes). This test
 * is what lets painting be OFFERED on an unsaved import; break it and paint silently misapplies.
 */
test('a staged import serializes triangles in the same order to STL and to 3MF', async () => {
  const { renderImportedMeshObjectXmlForTest } = await import('./three-mf-scene-builder.js')
  const mesh = {
    positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0],
    // Deliberately not sequential, so a serializer that ignored `indices` would be caught.
    indices: [0, 1, 2, 2, 3, 0, 1, 4, 2],
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 1, z: 0 } }
  }
  const stl = meshToBinaryStl(mesh)
  const xml = renderImportedMeshObjectXmlForTest(1, mesh)
  const xmlTriangles = [...xml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g)]
    .map((match) => [Number(match[1]), Number(match[2]), Number(match[3])])

  const triangleCount = stl.readUInt32LE(80)
  assert.equal(triangleCount, 3)
  assert.equal(xmlTriangles.length, 3)
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const offset = 84 + triangle * 50 + 12 + vertex * 12
      const stlVertex = [stl.readFloatLE(offset), stl.readFloatLE(offset + 4), stl.readFloatLE(offset + 8)]
      // The XML names a vertex INDEX; resolve it and compare coordinates.
      const index = xmlTriangles[triangle]![vertex]!
      const xmlVertex = [mesh.positions[index * 3]!, mesh.positions[index * 3 + 1]!, mesh.positions[index * 3 + 2]!]
      assert.deepEqual(stlVertex, xmlVertex, `triangle ${triangle} vertex ${vertex} disagrees`)
    }
  }
})
