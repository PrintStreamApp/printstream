import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectImportFormat, meshToBinaryStl, parseStlMesh } from './mesh-import.js'

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
