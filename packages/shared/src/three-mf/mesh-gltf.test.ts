/**
 * The glTF / GLB import parser.
 *
 * Built against real GLB bytes rather than a mocked document, because the container framing (chunk
 * lengths, 4-byte padding) and the accessor arithmetic (byteStride, component types) are exactly
 * where a parser goes wrong, and both are invisible to a JSON-only fixture.
 *
 * The metre-to-millimetre conversion gets its own coverage from several angles: getting it wrong is
 * silent in the file and total on the plate, and it is applied in TWO places (vertex coordinates and
 * the node translation column) that must agree.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseGltfMesh } from './mesh-gltf.js'
import { ModelImportError } from './imported-mesh.js'

/** Pack a JSON document and an optional binary chunk into a valid GLB. */
function glb(json: unknown, binary?: Uint8Array): Uint8Array {
  const jsonBytes = pad(new TextEncoder().encode(JSON.stringify(json)), 0x20)
  const binBytes = binary ? pad(binary, 0) : undefined
  const total = 12 + 8 + jsonBytes.length + (binBytes ? 8 + binBytes.length : 0)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true) // 'glTF'
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonBytes.length, true)
  view.setUint32(16, 0x4e4f534a, true) // 'JSON'
  out.set(jsonBytes, 20)
  if (binBytes) {
    const at = 20 + jsonBytes.length
    view.setUint32(at, binBytes.length, true)
    view.setUint32(at + 4, 0x004e4942, true) // 'BIN\0'
    out.set(binBytes, at + 8)
  }
  return out
}

/** GLB chunks are 4-byte aligned, and the padding is not counted in the chunk length. */
function pad(bytes: Uint8Array, filler: number): Uint8Array {
  const extra = (4 - (bytes.length % 4)) % 4
  if (extra === 0) return bytes
  const out = new Uint8Array(bytes.length + extra)
  out.set(bytes)
  out.fill(filler, bytes.length)
  return out
}

/** One triangle at 1m scale, as float32 positions plus uint16 indices. */
function triangleBuffer(): { bytes: Uint8Array; positionBytes: number } {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const indices = new Uint16Array([0, 1, 2])
  const bytes = new Uint8Array(positions.byteLength + indices.byteLength)
  bytes.set(new Uint8Array(positions.buffer), 0)
  bytes.set(new Uint8Array(indices.buffer), positions.byteLength)
  return { bytes, positionBytes: positions.byteLength }
}

/** A whole single-triangle GLB, optionally with a node transform. */
function triangleGlb(node: Record<string, unknown> = {}): Uint8Array {
  const { bytes, positionBytes } = triangleBuffer()
  return glb({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, ...node }],
    meshes: [{ name: 'Tri', primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes },
      { buffer: 0, byteOffset: positionBytes, byteLength: 6 }
    ],
    buffers: [{ byteLength: bytes.length }]
  }, bytes)
}

test('a GLB triangle parses, converted from metres to millimetres', () => {
  // glTF is defined in metres (spec 3.4). A 1-unit triangle is a 1000mm one; read as millimetres it
  // would arrive 1mm across, which reads as an import that silently failed.
  const mesh = parseGltfMesh(triangleGlb())
  assert.equal(mesh.indices.length / 3, 1)
  assert.deepEqual(mesh.bounds, { min: { x: 0, y: 0, z: 0 }, max: { x: 1000, y: 1000, z: 0 } })
})

test('a node translation is scaled to millimetres alongside the coordinates it moves', () => {
  // The conversion is applied in two places and they must agree: scaling the vertices but not the
  // translation puts a correctly-sized model a thousandth of the way to where it belongs.
  const mesh = parseGltfMesh(triangleGlb({ translation: [2, 0, 0] }))
  assert.equal(mesh.bounds.min.x, 2000)
  assert.equal(mesh.bounds.max.x, 3000)
})

test('a node scale is NOT converted, being dimensionless', () => {
  // Scaling the whole matrix rather than its translation column would cube the model.
  const mesh = parseGltfMesh(triangleGlb({ scale: [2, 2, 2] }))
  assert.equal(mesh.bounds.max.x, 2000)
})

test('a node matrix is honoured as column-major', () => {
  // Reading it row-major transposes rotation, which is invisible on an axis-aligned fixture and
  // wrong on everything else -- so the fixture translates, where the two orders genuinely differ.
  const mesh = parseGltfMesh(triangleGlb({
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1]
  }))
  assert.equal(mesh.bounds.min.x, 5000)
})

test('an interleaved vertex buffer is read through its byteStride', () => {
  // The common output of every real-time exporter. Read as tightly packed, the normal and UV data
  // between positions would be returned AS coordinates -- an explosion of stray triangles, not an error.
  const stride = 32 // position (12) + normal (12) + uv (8)
  const data = new Uint8Array(stride * 3 + 6)
  const view = new DataView(data.buffer)
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0]]
  corners.forEach(([x, y, z], vertex) => {
    view.setFloat32(vertex * stride, x!, true)
    view.setFloat32(vertex * stride + 4, y!, true)
    view.setFloat32(vertex * stride + 8, z!, true)
    // Junk in the normal/uv slots that must never be read as a coordinate.
    view.setFloat32(vertex * stride + 12, 999, true)
    view.setFloat32(vertex * stride + 24, -999, true)
  })
  new Uint16Array(data.buffer, stride * 3, 3).set([0, 1, 2])

  const mesh = parseGltfMesh(glb({
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }], scene: 0,
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: stride * 3, byteStride: stride },
      { buffer: 0, byteOffset: stride * 3, byteLength: 6 }
    ],
    buffers: [{ byteLength: data.length }]
  }, data))

  assert.equal(mesh.indices.length / 3, 1)
  assert.deepEqual(mesh.bounds, { min: { x: 0, y: 0, z: 0 }, max: { x: 1000, y: 1000, z: 0 } })
})

test('several primitives become parts sharing one coordinate space', () => {
  const { bytes, positionBytes } = triangleBuffer()
  const mesh = parseGltfMesh(glb({
    asset: { version: '2.0' },
    scenes: [{ nodes: [0, 1] }], scene: 0,
    nodes: [{ mesh: 0 }, { mesh: 0, translation: [5, 0, 0] }],
    meshes: [{ name: 'Tri', primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes },
      { buffer: 0, byteOffset: positionBytes, byteLength: 6 }
    ],
    buffers: [{ byteLength: bytes.length }]
  }, bytes))

  assert.equal(mesh.parts?.length, 2)
  // The second instance keeps its own placement, so the merged bounds span both.
  assert.equal(mesh.bounds.max.x, 6000)
})

test('a child node composes its parent transform', () => {
  const { bytes, positionBytes } = triangleBuffer()
  const mesh = parseGltfMesh(glb({
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }], scene: 0,
    nodes: [{ children: [1], translation: [1, 0, 0] }, { mesh: 0, translation: [2, 0, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes },
      { buffer: 0, byteOffset: positionBytes, byteLength: 6 }
    ],
    buffers: [{ byteLength: bytes.length }]
  }, bytes))
  // 1m parent + 2m child = 3m, i.e. 3000mm.
  assert.equal(mesh.bounds.min.x, 3000)
})

test('an unindexed primitive is read as sequential triangles', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const bytes = new Uint8Array(positions.buffer.slice(0))
  const mesh = parseGltfMesh(glb({
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }], scene: 0,
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bytes.length }],
    buffers: [{ byteLength: bytes.length }]
  }, bytes))
  assert.equal(mesh.indices.length / 3, 1)
})

test('a non-triangle primitive is skipped, not refused', () => {
  // A scene legitimately mixes a mesh with debug lines; the mesh is still worth importing.
  const { bytes, positionBytes } = triangleBuffer()
  const mesh = parseGltfMesh(glb({
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }], scene: 0,
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [
      { attributes: { POSITION: 0 }, indices: 1, mode: 1 },
      { attributes: { POSITION: 0 }, indices: 1 }
    ] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes },
      { buffer: 0, byteOffset: positionBytes, byteLength: 6 }
    ],
    buffers: [{ byteLength: bytes.length }]
  }, bytes))
  assert.equal(mesh.indices.length / 3, 1)
  assert.equal(mesh.parts, undefined, 'the line primitive contributed nothing, so one part remains')
})

test('a Draco-compressed primitive is refused with a reason', () => {
  // The geometry is behind a codec we do not ship, so the accessors are unreadable. Saying so beats
  // importing a scene that is silently missing half its meshes.
  assert.throws(() => parseGltfMesh(glb({
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }], scene: 0,
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, extensions: { KHR_draco_mesh_compression: {} } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36 }]
  }, new Uint8Array(36))), /Draco/)
})

test('a glTF naming an external buffer is refused with a reason', () => {
  // Both hosts import a SINGLE file, so a sibling .bin is one we are never handed.
  const json = new TextEncoder().encode(JSON.stringify({
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }], scene: 0,
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    buffers: [{ uri: 'scene.bin', byteLength: 36 }]
  }))
  assert.throws(() => parseGltfMesh(json), /separate binary file/)
})

test('a base64 data URI buffer is decoded, so a self-contained .gltf works', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const raw = new Uint8Array(positions.buffer.slice(0))
  const base64 = Buffer.from(raw).toString('base64')
  const json = new TextEncoder().encode(JSON.stringify({
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }], scene: 0,
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: raw.length }],
    buffers: [{ uri: `data:application/octet-stream;base64,${base64}`, byteLength: raw.length }]
  }))
  const mesh = parseGltfMesh(json)
  assert.equal(mesh.indices.length / 3, 1)
  assert.equal(mesh.bounds.max.x, 1000)
})

test('an accessor reaching past its buffer is refused rather than read', () => {
  // Every offset here is attacker-supplied; an unchecked window is the cheapest way to make a
  // parser read memory that is not its own.
  const { bytes, positionBytes } = triangleBuffer()
  assert.throws(() => parseGltfMesh(glb({
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }], scene: 0,
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 100_000, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positionBytes }],
    buffers: [{ byteLength: bytes.length }]
  }, bytes)), /truncated/)
})

test('a node cycle terminates instead of exhausting the stack', () => {
  // `children` is a free-form index list, so a malformed file can point a node at its own ancestor.
  const { bytes, positionBytes } = triangleBuffer()
  const mesh = parseGltfMesh(glb({
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }], scene: 0,
    nodes: [{ children: [1] }, { children: [0], mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes },
      { buffer: 0, byteOffset: positionBytes, byteLength: 6 }
    ],
    buffers: [{ byteLength: bytes.length }]
  }, bytes))
  assert.equal(mesh.indices.length / 3, 1)
})

test('a triangle index outside the POSITION accessor is refused', () => {
  // NOT implied by the accessor bounds check: an index can sit inside its own accessor and still
  // name a vertex the positions do not have. Unchecked it survives everything -- the weld
  // early-returns when nothing merged, the STL writer draws a spike to the origin, and a SAVE emits
  // `<triangle v3="9"/>` for a 3-vertex object, i.e. an invalid 3MF.
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const indices = new Uint16Array([0, 1, 9])
  const bytes = new Uint8Array(positions.byteLength + indices.byteLength)
  bytes.set(new Uint8Array(positions.buffer), 0)
  bytes.set(new Uint8Array(indices.buffer), positions.byteLength)
  assert.throws(() => parseGltfMesh(glb({
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }], scene: 0,
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: 6 }
    ],
    buffers: [{ byteLength: bytes.length }]
  }, bytes)), /invalid vertex index/)
})

test('a document with no usable scenes entry still composes parent transforms', () => {
  // `scene` and `scenes` are both OPTIONAL, and `scene` may index past the array. The fallback used
  // to treat every node as a root, which combined with the LIFO walk pops a CHILD before its parent,
  // marks it visited, and blocks the parent's push -- silently discarding the parent's transform and
  // importing the whole hierarchy collapsed at the origin.
  const { bytes, positionBytes } = triangleBuffer()
  const document = (scene: Record<string, unknown>) => glb({
    asset: { version: '2.0' },
    ...scene,
    nodes: [{ children: [1], translation: [5, 0, 0] }, { mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes },
      { buffer: 0, byteOffset: positionBytes, byteLength: 6 }
    ],
    buffers: [{ byteLength: bytes.length }]
  }, bytes)

  // The declared-scene case is the control: all three must agree.
  assert.equal(parseGltfMesh(document({ scene: 0, scenes: [{ nodes: [0] }] })).bounds.min.x, 5000)
  assert.equal(parseGltfMesh(document({})).bounds.min.x, 5000, 'no scenes key')
  assert.equal(parseGltfMesh(document({ scene: 7, scenes: [{ nodes: [0] }] })).bounds.min.x, 5000, 'scene index out of range')
})

test('a mirroring node has its triangle winding reversed', () => {
  // A negative determinant flips handedness, so baked geometry keeps winding that now points INTO
  // the solid. Both writers zero the stored normal and let the slicer recompute from winding, so
  // nothing downstream can recover it: the part slices inside-out with nothing logged. Mirrored
  // instances are routine (a symmetric assembly authored once, instanced with -1).
  const { bytes, positionBytes } = triangleBuffer()
  const signedArea = (scale: number[]): number => {
    const mesh = parseGltfMesh(glb({
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }], scene: 0,
      nodes: [{ mesh: 0, scale }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positionBytes },
        { buffer: 0, byteOffset: positionBytes, byteLength: 6 }
      ],
      buffers: [{ byteLength: bytes.length }]
    }, bytes))
    const [a, b, c] = [0, 1, 2].map((corner) => {
      const at = mesh.indices[corner]! * 3
      return [mesh.positions[at]!, mesh.positions[at + 1]!]
    })
    return (b![0]! - a![0]!) * (c![1]! - a![1]!) - (b![1]! - a![1]!) * (c![0]! - a![0]!)
  }
  // Same sign either way: the mirrored instance still faces outward.
  assert.ok(signedArea([1, 1, 1]) > 0, 'control: an unmirrored triangle winds positive')
  assert.ok(signedArea([-1, 1, 1]) > 0, 'a mirrored triangle must not wind inside-out')
})

test('a malformed data URI is refused as a data error, not left to atob', () => {
  // `atob` throws a DOMException, which in a BROWSER is not `instanceof Error` at all, so it escapes
  // the staging worker's data-vs-mechanism test entirely: the client re-parses on the main thread
  // (freezing the tab) and then shows the user "Invalid character" as the reason.
  const json = new TextEncoder().encode(JSON.stringify({
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }], scene: 0,
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    buffers: [{ uri: 'data:application/octet-stream;base64,!!!not base64!!!', byteLength: 36 }]
  }))
  const error = (() => { try { parseGltfMesh(json); return null } catch (caught) { return caught } })()
  assert.ok(error instanceof ModelImportError, 'must surface as a ModelImportError')
})

test('every refusal is a ModelImportError, so the worker can classify by type', () => {
  // The staging worker asks `instanceof` rather than matching message text. A refusal thrown as a
  // bare Error is misclassified as a MECHANISM failure and triggers the main-thread re-parse that
  // classification exists to prevent.
  const error = (() => {
    try { parseGltfMesh(new TextEncoder().encode('not a model')); return null } catch (caught) { return caught }
  })()
  assert.ok(error instanceof ModelImportError)
})

test('a document with no readable geometry is refused', () => {
  assert.throws(
    () => parseGltfMesh(glb({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0, nodes: [] })),
    /contained no triangles/
  )
})

test('bytes that are not glTF at all are refused, not misread', () => {
  assert.throws(() => parseGltfMesh(new TextEncoder().encode('not a model')), /could not be read/)
})
