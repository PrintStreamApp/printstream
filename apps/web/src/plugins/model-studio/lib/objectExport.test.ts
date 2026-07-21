import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import {
  buildObjectStl,
  buildObjectsStl,
  buildPartsStl,
  groupHasExcludedVolumes,
  stlExportBaseName,
  stlExportFileName
} from './objectExport'

const STL_HEADER_BYTES = 84
const STL_TRIANGLE_BYTES = 50

/** A unit-cube mesh (12 triangles) at the given position, optionally tagged. */
function cubeMesh(position: [number, number, number], userData: Record<string, boolean> = {}): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
  mesh.position.set(...position)
  Object.assign(mesh.userData, userData)
  return mesh
}

function stlTriangleCount(stl: ArrayBuffer): number {
  return new DataView(stl).getUint32(80, true)
}

test('buildObjectStl merges model meshes and skips modifier and overlay meshes', () => {
  const group = new THREE.Group()
  group.add(cubeMesh([0, 0, 0]))
  group.add(cubeMesh([3, 0, 0]))
  group.add(cubeMesh([6, 0, 0], { isHelperVolume: true }))
  group.add(cubeMesh([9, 0, 0], { isPaintOverlay: true }))
  const stl = buildObjectStl(group)
  assert.ok(stl)
  assert.equal(stlTriangleCount(stl), 24)
  assert.equal(stl.byteLength, STL_HEADER_BYTES + 24 * STL_TRIANGLE_BYTES)
})

test('buildObjectStl bakes world transforms and re-centres onto the origin', () => {
  const group = new THREE.Group()
  group.position.set(120, -45, 0)
  group.scale.set(2, 2, 2)
  group.add(cubeMesh([0, 0, 10]))
  const stl = buildObjectStl(group)
  assert.ok(stl)
  const view = new DataView(stl)
  let minX = Infinity; let maxX = -Infinity
  let minY = Infinity; let maxY = -Infinity
  let minZ = Infinity; let maxZ = -Infinity
  for (let tri = 0; tri < stlTriangleCount(stl); tri++) {
    // Per-triangle record: 12 bytes normal, then three 12-byte vertices.
    for (let vertexIndex = 0; vertexIndex < 3; vertexIndex++) {
      const at = STL_HEADER_BYTES + tri * STL_TRIANGLE_BYTES + 12 + vertexIndex * 12
      const x = view.getFloat32(at, true)
      const y = view.getFloat32(at + 4, true)
      const z = view.getFloat32(at + 8, true)
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
    }
  }
  // Scale survives (2x cube), XY is centred, and the bottom rests on Z=0.
  assert.ok(Math.abs((maxX - minX) - 2) < 1e-5)
  assert.ok(Math.abs(minX + maxX) < 1e-5)
  assert.ok(Math.abs(minY + maxY) < 1e-5)
  assert.ok(Math.abs(minZ) < 1e-5)
  assert.ok(Math.abs(maxZ - 2) < 1e-5)
})

test('buildObjectStl returns null when the group has no solid geometry', () => {
  const empty = new THREE.Group()
  assert.equal(buildObjectStl(empty), null)
  const modifiersOnly = new THREE.Group()
  modifiersOnly.add(cubeMesh([0, 0, 0], { isHelperVolume: true }))
  assert.equal(buildObjectStl(modifiersOnly), null)
})

test('buildObjectsStl merges several groups into one STL, keeping relative placement', () => {
  const left = new THREE.Group()
  left.position.set(-10, 0, 0)
  left.add(cubeMesh([0, 0, 0]))
  const right = new THREE.Group()
  right.position.set(10, 0, 0)
  right.add(cubeMesh([0, 0, 0]))
  const stl = buildObjectsStl([left, right])
  assert.ok(stl)
  assert.equal(stlTriangleCount(stl), 24)
  // Relative placement survives the shared rebase: the merged bbox spans both cubes.
  const view = new DataView(stl)
  let minX = Infinity; let maxX = -Infinity
  for (let tri = 0; tri < 24; tri++) {
    for (let vertexIndex = 0; vertexIndex < 3; vertexIndex++) {
      const at = STL_HEADER_BYTES + tri * STL_TRIANGLE_BYTES + 12 + vertexIndex * 12
      const x = view.getFloat32(at, true)
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    }
  }
  assert.ok(Math.abs((maxX - minX) - 21) < 1e-5)
  assert.ok(Math.abs(minX + maxX) < 1e-5)
})

/** A part group tagged the way the editor tags render parts. */
function partGroup(tag: 'partRef' | 'importPartRef', componentObjectId: number, position: [number, number, number], modifier = false): THREE.Group {
  const group = new THREE.Group()
  group.userData[tag] = { componentObjectId }
  group.add(cubeMesh(position, modifier ? { isHelperVolume: true } : {}))
  return group
}

test('buildPartsStl exports only the matched parts, including selected helper volumes', () => {
  const group = new THREE.Group()
  group.add(partGroup('partRef', 1, [0, 0, 0]))
  group.add(partGroup('partRef', 2, [3, 0, 0]))
  group.add(partGroup('partRef', 3, [6, 0, 0], true))
  const one = buildPartsStl(group, [1])
  assert.ok(one)
  assert.equal(stlTriangleCount(one), 12)
  // A selected modifier/negative part IS exported (picking it is the deliberate ask).
  const withHelper = buildPartsStl(group, [2, 3])
  assert.ok(withHelper)
  assert.equal(stlTriangleCount(withHelper), 24)
  assert.equal(buildPartsStl(group, [99]), null)
})

test('buildPartsStl matches importPartRef tags (multi-solid STEP imports)', () => {
  const group = new THREE.Group()
  group.add(partGroup('importPartRef', 0, [0, 0, 0]))
  group.add(partGroup('importPartRef', 1, [3, 0, 0]))
  const stl = buildPartsStl(group, [1])
  assert.ok(stl)
  assert.equal(stlTriangleCount(stl), 12)
})

test('groupHasExcludedVolumes detects modifier-tagged meshes', () => {
  const plain = new THREE.Group()
  plain.add(cubeMesh([0, 0, 0]))
  assert.equal(groupHasExcludedVolumes(plain), false)
  plain.add(cubeMesh([2, 0, 0], { isHelperVolume: true }))
  assert.equal(groupHasExcludedVolumes(plain), true)
})

test('stlExportBaseName sanitizes unsafe characters and falls back', () => {
  assert.equal(stlExportBaseName('Benchy v2'), 'Benchy v2')
  assert.equal(stlExportBaseName('bracket/left:final?'), 'bracket left final')
  assert.equal(stlExportBaseName('   '), 'object')
  assert.equal(stlExportBaseName('hull.stl'), 'hull')
})

test('stlExportFileName appends a single .stl extension', () => {
  assert.equal(stlExportFileName('gear'), 'gear.stl')
  assert.equal(stlExportFileName('gear.stl'), 'gear.stl')
})
