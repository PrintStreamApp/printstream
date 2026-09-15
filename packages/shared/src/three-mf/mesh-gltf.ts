/**
 * glTF 2.0 / GLB geometry import.
 *
 * OWNS turning a `.gltf` or `.glb` asset into an {@link ImportedMesh}. Shared for the same reason
 * the STL, OBJ and AMF parsers are: the api parses an upload, the browser parses a file the user
 * picked for the public editor, and a file must not import differently depending on the host.
 *
 * WHY NOT three.js's `GLTFLoader`. It is already in the web app, but `packages/shared` depends on
 * `zod` alone and is consumed by the api and the bridge, so pulling three.js in would land a
 * browser-oriented 3D library in two processes that have no use for one. The loader also produces
 * host-specific scene objects, while this module produces the flat mesh, source colours, and part
 * structure the 3MF writer and filament mapper actually need.
 *
 * NODES ARE FLATTENED, MESHES BECOME PARTS. A glTF scene is a transform hierarchy; a 3MF import is
 * one object. So each node's world matrix is composed down the tree and baked into its vertices, and
 * every mesh PRIMITIVE becomes one {@link ImportedMesh.parts} entry -- the same treatment a
 * multi-solid STEP assembly gets, so an imported scene arrives as one object the user can move as a
 * unit with its pieces still individually selectable.
 *
 * UNITS. glTF is defined in METRES (spec 3.4: "The units for all linear distances are meters"), so
 * every coordinate is scaled by 1000 on the way in. Getting this wrong is invisible in the file and
 * expensive on the plate: a 40mm part would arrive 0.04mm across, which reads as an import that
 * silently failed rather than one that landed at the wrong scale.
 *
 * NOT SUPPORTED, and each one is REFUSED rather than partly honoured:
 *  - Draco / meshopt / any `KHR_draco_mesh_compression` primitive: the geometry is behind a codec we
 *    do not ship, so the accessor data is not readable at all.
 *  - A `.gltf` naming external buffers or images by relative URI. Both hosts import a SINGLE file,
 *    so a sibling resource is a file we are never handed. Embedded `data:` URIs and GLB buffer
 *    views are fine, which is what the great majority of exported assets use.
 * Both throw with the reason, because a scene that quietly imports missing half its meshes is worse
 * than one that says why it cannot.
 *
 * Base-colour textures and factors become filament-paint source colours. Other material channels,
 * animation, skins, and morph targets are not represented by a printable triangle surface.
 */
import { assertImportTriangleBudget, computeMeshBounds, MAX_IMPORT_TRIANGLES, mergeImportedMeshes, weldImportedMeshVertices } from './mesh-stl.js'
import { ModelImportError } from './imported-mesh.js'
import type { ImportedMesh, ImportedMeshPart } from './imported-mesh.js'
import { sampleTexturedTriangles, type DecodedTextureImage } from './mesh-texture.js'
import {
  countTexturedGltfPrimitiveInstances,
  decodeGltfDataUri,
  decodeReferencedGltfTextureImages,
  gltfPrimitiveAppearance,
  texturedTrianglesFromGltfPrimitive
} from './mesh-gltf-texture.js'

/** glTF works in metres; every other format here and the 3MF writer work in millimetres. */
const GLTF_MILLIMETRES_PER_UNIT = 1000

/** `glTF` as little-endian u32, the GLB container's first four bytes. */
const GLB_MAGIC = 0x46546c67
const GLB_CHUNK_JSON = 0x4e4f534a
const GLB_CHUNK_BIN = 0x004e4942

/** Only `5126` (FLOAT) positions and the three unsigned integer index types are meaningful here. */
const COMPONENT_BYTES: Readonly<Record<number, number>> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }

/** glTF primitive modes; only `4` (TRIANGLES) describes a printable surface. */
const MODE_TRIANGLES = 4

/**
 * Parse a `.glb` or `.gltf` file into a mesh, with one part per primitive.
 *
 * Accepts bytes rather than text so the GLB and JSON containers can be told apart by magic number
 * exactly as a binary and ASCII STL are, rather than by trusting the extension the user typed.
 */
export function parseGltfMesh(
  bytes: Uint8Array,
  options: { decodedImages?: ReadonlyMap<number, DecodedTextureImage> } = {}
): ImportedMesh {
  const { json, binary } = isGlb(bytes) ? readGlbChunks(bytes) : { json: readGltfJson(bytes), binary: undefined }
  const buffers = resolveBuffers(json, binary)
  const parts: ImportedMeshPart[] = []
  const flatNodes = flattenNodes(json)
  const texturedPrimitiveCount = countTexturedGltfPrimitiveInstances(json, flatNodes, options.decodedImages)
  const textureTarget = texturedPrimitiveCount > 0 ? Math.ceil(10_000 / texturedPrimitiveCount) : 0
  let triangleCount = 0
  let outputTriangleCount = 0

  for (const node of flatNodes) {
    const mesh = (json.meshes ?? [])[node.mesh]
    if (mesh == null) continue
    for (const [index, primitive] of (mesh.primitives ?? []).entries()) {
      if (primitive.extensions?.KHR_draco_mesh_compression != null) {
        throw new ModelImportError('This glTF uses Draco mesh compression, which cannot be imported')
      }
      // An absent `mode` defaults to TRIANGLES per the spec; anything else is a point cloud, a line
      // set or a strip/fan, none of which is printable geometry. Skipped rather than refused: a scene
      // legitimately mixes a mesh with debug lines, and the meshes are still worth importing.
      if ((primitive.mode ?? MODE_TRIANGLES) !== MODE_TRIANGLES) continue
      const positionAccessor = primitive.attributes?.POSITION
      if (positionAccessor == null) continue

      const positions = readAccessorFloats(json, buffers, positionAccessor, 3)
      const indices = primitive.indices == null
        ? Array.from({ length: positions.length / 3 }, (_, vertex) => vertex)
        : readAccessorIntegers(json, buffers, primitive.indices)
      if (indices.length < 3) continue
      if (indices.length % 3 !== 0) throw new ModelImportError('glTF triangle index count is not divisible by three')

      // Indices come from the file and are NOT implied by the accessor bounds check: an index may
      // sit comfortably inside its own accessor and still name a vertex the POSITION accessor does
      // not have. Left unchecked it survives the whole pipeline -- the weld early-returns when
      // nothing merged, `meshToBinaryStl` reads `positions[n] ?? 0` and draws a spike to the
      // origin, and a SAVE writes `<triangle v3="9"/>` into an object with three vertices, i.e. an
      // invalid 3MF. Both sibling parsers validate theirs; this one is the odd one out.
      const vertexCount = positions.length / 3
      for (const index of indices) {
        if (!Number.isInteger(index) || index < 0 || index >= vertexCount) {
          throw new ModelImportError('glTF contains an invalid vertex index')
        }
      }

      triangleCount += Math.floor(indices.length / 3)
      assertImportTriangleBudget(triangleCount)

      applyNodeMatrix(positions, node.matrix)
      // A negative determinant means the node MIRRORS. Baking such a matrix into the vertices
      // reverses the geometry's handedness, so the triangles' winding no longer describes their
      // outward face and the solid is inside-out. The 3MF and STL writers both zero the stored
      // normal and let the slicer recompute from winding, so nothing downstream can recover it.
      // Mirrored instances are routine (a symmetric assembly authored once, instanced with -1).
      if (matrixMirrors(node.matrix)) reverseTriangleWinding(indices)
      const name = (mesh.name ?? node.name ?? `Mesh ${parts.length + 1}`) +
        ((mesh.primitives ?? []).length > 1 ? ` (${index + 1})` : '')
      const appearance = gltfPrimitiveAppearance(
        json,
        buffers,
        primitive,
        vertexCount,
        options.decodedImages,
        readTextureCoordinates
      )
      let imported: ImportedMesh
      if (appearance?.texture && appearance.uvs) {
        const triangles = texturedTrianglesFromGltfPrimitive(
          positions,
          indices,
          appearance.uvs,
          appearance.texture,
          appearance.factor,
          { wrapU: appearance.wrapU, wrapV: appearance.wrapV }
        )
        imported = sampleTexturedTriangles(triangles, {
          targetTriangles: textureTarget,
          maxTriangles: Math.max(triangles.length, MAX_IMPORT_TRIANGLES - outputTriangleCount)
        })
      } else {
        const triangleCornerColors = appearance?.hasExplicitFactor
          ? Array.from({ length: indices.length }, () => appearance.factor).flat()
          : undefined
        imported = weldImportedMeshVertices({
          positions,
          indices,
          bounds: computeMeshBounds(positions),
          ...(triangleCornerColors
            ? { triangleCornerColors, sourceColorMode: 'material' as const }
            : {})
        })
      }
      outputTriangleCount += imported.indices.length / 3
      assertImportTriangleBudget(outputTriangleCount)
      parts.push({ name, mesh: imported })
    }
  }

  if (parts.length === 0) throw new ModelImportError('glTF contained no triangles')
  const merged = mergeImportedMeshes(parts.map((part) => part.mesh))
  return parts.length > 1 ? { ...merged, parts } : merged
}

/**
 * Decode only image sources reached by mesh primitives in the active scene.
 *
 * External image URIs are refused because the editor currently stages glTF as one self-contained
 * file. Embedded data URIs and GLB buffer-view images are passed to the host image decoder.
 */
export async function decodeGltfTextureImages(
  bytes: Uint8Array,
  decodeTexture: (name: string, bytes: Uint8Array) => Promise<DecodedTextureImage> | DecodedTextureImage
): Promise<Map<number, DecodedTextureImage>> {
  const { json, binary } = isGlb(bytes) ? readGlbChunks(bytes) : { json: readGltfJson(bytes), binary: undefined }
  const buffers = resolveBuffers(json, binary)
  return decodeReferencedGltfTextureImages(json, buffers, flattenNodes(json), decodeTexture)
}

// ---------------------------------------------------------------------------------------------
// Containers

function isGlb(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && viewOf(bytes).getUint32(0, true) === GLB_MAGIC
}

/** A DataView over exactly this view's bytes; a Uint8Array may be a window onto a larger buffer. */
function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/**
 * Split a GLB into its JSON and (optional) binary chunks.
 *
 * Chunk lengths are attacker-supplied, so each is bounds-checked against the file rather than
 * trusted: an overlong length would otherwise read past the buffer.
 */
function readGlbChunks(bytes: Uint8Array): { json: GltfDocument; binary?: Uint8Array } {
  const view = viewOf(bytes)
  let offset = 12
  let json: GltfDocument | undefined
  let binary: Uint8Array | undefined
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset, true)
    const type = view.getUint32(offset + 4, true)
    const start = offset + 8
    if (start + length > bytes.length) throw new ModelImportError('glTF file is truncated')
    if (type === GLB_CHUNK_JSON) json = parseJsonDocument(bytes.subarray(start, start + length))
    else if (type === GLB_CHUNK_BIN) binary = bytes.subarray(start, start + length)
    // Chunks are 4-byte aligned, and the padding is not counted in `length`.
    offset = start + length + ((4 - (length % 4)) % 4)
  }
  if (!json) throw new ModelImportError('glTF file has no JSON chunk')
  return binary ? { json, binary } : { json }
}

function readGltfJson(bytes: Uint8Array): GltfDocument {
  return parseJsonDocument(bytes)
}

function parseJsonDocument(bytes: Uint8Array): GltfDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new ModelImportError('glTF file could not be read')
  }
  if (parsed == null || typeof parsed !== 'object') throw new ModelImportError('glTF file could not be read')
  return parsed as GltfDocument
}

/**
 * Materialise every declared buffer.
 *
 * A buffer with no `uri` is GLB's own binary chunk. A `data:` URI is decoded inline. Anything else
 * names a sibling file, which a single-file import cannot resolve -- refused here, where the reason
 * can still be stated, rather than surfacing later as a scene that imported no geometry.
 */
function resolveBuffers(json: GltfDocument, binary: Uint8Array | undefined): Uint8Array[] {
  return (json.buffers ?? []).map((buffer) => {
    if (buffer.uri == null) {
      if (!binary) throw new ModelImportError('glTF file is missing its binary chunk')
      return binary
    }
    if (buffer.uri.startsWith('data:')) return decodeGltfDataUri(buffer.uri)
    throw new ModelImportError('This glTF refers to a separate binary file, so only a self-contained .glb or .gltf can be imported')
  })
}

// ---------------------------------------------------------------------------------------------
// Accessors

/**
 * Read an accessor as flat floats, `components` per element.
 *
 * Honours `byteStride`, which is what an interleaved vertex buffer (the common output of every
 * real-time exporter) uses: reading it as tightly packed would return position, normal and UV data
 * jumbled together as coordinates, producing an explosion of stray triangles rather than an error.
 */
function readAccessorFloats(json: GltfDocument, buffers: Uint8Array[], accessorIndex: number, components: number): number[] {
  const { view, accessor, stride } = accessorView(json, buffers, accessorIndex)
  const size = COMPONENT_BYTES[accessor.componentType]
  if (size == null || accessor.componentType !== 5126 || accessor.type !== 'VEC3') {
    throw new ModelImportError('glTF vertex positions are in a format that cannot be imported')
  }
  const out: number[] = []
  for (let element = 0; element < accessor.count; element += 1) {
    const base = element * (stride || components * size)
    for (let component = 0; component < components; component += 1) {
      out.push(view.getFloat32(base + component * size, true) * GLTF_MILLIMETRES_PER_UNIT)
    }
  }
  return out
}

/** Read VEC2 texture coordinates, including the normalized integer encodings glTF permits. */
function readTextureCoordinates(json: GltfDocument, buffers: Uint8Array[], accessorIndex: number): number[] {
  const { view, accessor, stride } = accessorView(json, buffers, accessorIndex)
  if (accessor.type !== 'VEC2') throw new ModelImportError('glTF texture coordinates are in a format that cannot be imported')
  const size = COMPONENT_BYTES[accessor.componentType]
  if (size == null) throw new ModelImportError('glTF texture coordinates are in a format that cannot be imported')
  let read: ((at: number) => number) | null = null
  if (accessor.componentType === 5126) {
    read = (at) => view.getFloat32(at, true)
  } else if (accessor.componentType === 5121 && accessor.normalized) {
    read = (at) => view.getUint8(at) / 255
  } else if (accessor.componentType === 5123 && accessor.normalized) {
    read = (at) => view.getUint16(at, true) / 65535
  }
  if (!read) throw new ModelImportError('glTF texture coordinates are in a format that cannot be imported')
  const out: number[] = []
  for (let element = 0; element < accessor.count; element += 1) {
    const base = element * (stride || 2 * size)
    out.push(read(base), read(base + size))
  }
  return out
}

/**
 * Read an accessor as flat integers (triangle indices).
 *
 * Only the three UNSIGNED types the spec allows for indices are accepted. Falling back to a byte
 * read for anything else would silently misread a 2-byte signed accessor as half as many wrong
 * indices, which produces a mesh rather than an error -- so an unexpected type is refused instead.
 */
function readAccessorIntegers(json: GltfDocument, buffers: Uint8Array[], accessorIndex: number): number[] {
  const { view, accessor, stride } = accessorView(json, buffers, accessorIndex)
  const read = INDEX_READERS[accessor.componentType]
  if (!read) throw new ModelImportError('glTF triangle indices are in a format that cannot be imported')
  const step = stride || COMPONENT_BYTES[accessor.componentType]!
  const out: number[] = []
  for (let element = 0; element < accessor.count; element += 1) out.push(read(view, element * step))
  return out
}

/** The index component types glTF permits: UNSIGNED_BYTE, UNSIGNED_SHORT, UNSIGNED_INT. */
const INDEX_READERS: Readonly<Record<number, (view: DataView, at: number) => number>> = {
  5121: (view, at) => view.getUint8(at),
  5123: (view, at) => view.getUint16(at, true),
  5125: (view, at) => view.getUint32(at, true)
}

/**
 * Resolve an accessor to a bounds-checked `DataView` over its slice of its buffer.
 *
 * Every offset and length here comes from the file, so the window is validated against the buffer
 * before any read: an out-of-range `byteOffset`/`count` pair is the cheapest way to make a parser
 * read memory that is not its own.
 */
function accessorView(json: GltfDocument, buffers: Uint8Array[], accessorIndex: number): {
  view: DataView
  accessor: GltfAccessor
  stride: number
} {
  const accessor = (json.accessors ?? [])[accessorIndex]
  if (!accessor) throw new ModelImportError('glTF file is missing mesh data')
  if (accessor.sparse != null) throw new ModelImportError('glTF sparse accessors cannot be imported')
  const bufferView = (json.bufferViews ?? [])[accessor.bufferView ?? -1]
  if (!bufferView) throw new ModelImportError('glTF file is missing mesh data')
  const buffer = buffers[bufferView.buffer]
  if (!buffer) throw new ModelImportError('glTF file is missing mesh data')

  const size = COMPONENT_BYTES[accessor.componentType] ?? 0
  const components = ACCESSOR_COMPONENTS[accessor.type] ?? 0
  if (size === 0 || components === 0) throw new ModelImportError('glTF file is missing mesh data')
  const stride = bufferView.byteStride ?? 0
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
  const span = accessor.count <= 0 ? 0 : (accessor.count - 1) * (stride || components * size) + components * size
  if (start < 0 || accessor.count < 0 || start + span > buffer.byteLength) {
    throw new ModelImportError('glTF file is truncated')
  }
  return { view: new DataView(buffer.buffer, buffer.byteOffset + start, span), accessor, stride }
}

const ACCESSOR_COMPONENTS: Readonly<Record<string, number>> = {
  SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16
}

// ---------------------------------------------------------------------------------------------
// Scene graph

interface FlatNode { mesh: number; name?: string; matrix: number[] }

/**
 * Walk the scene graph and return every mesh-bearing node with its WORLD matrix.
 *
 * Iterative with an explicit stack, and cycle-guarded by a visited set: `nodes[].children` is a
 * free-form index list, so a malformed or hostile file can point a node at its own ancestor, which a
 * recursive walk would follow until the stack ran out.
 */
function flattenNodes(json: GltfDocument): FlatNode[] {
  const nodes = json.nodes ?? []
  const scene = (json.scenes ?? [])[json.scene ?? 0]
  // A file with no usable `scenes` entry is legal (both keys are optional, and `scene` may index
  // past the array), so the fallback has to name the roots itself -- and "every node" is NOT the
  // right answer. Combined with the LIFO stack below, listing a child as a root pops it BEFORE its
  // parent, `visited` then blocks the parent's push of it, and the parent's transform is silently
  // discarded: an entire hierarchy imports collapsed at the origin with nothing logged.
  // A root is a node nothing else claims as a child, which is what the scene list would have said.
  const roots = scene?.nodes ?? rootNodeIndexes(nodes)
  const out: FlatNode[] = []
  const visited = new Set<number>()
  const stack: Array<{ index: number; parent: number[] }> = roots.map((index) => ({ index, parent: IDENTITY }))

  while (stack.length > 0) {
    const { index, parent } = stack.pop()!
    if (visited.has(index)) continue
    visited.add(index)
    const node = nodes[index]
    if (!node) continue
    const matrix = multiply(parent, localMatrix(node))
    if (node.mesh != null) out.push({ mesh: node.mesh, name: node.name, matrix })
    for (const child of node.children ?? []) stack.push({ index: child, parent: matrix })
  }
  return out
}

/**
 * Nodes no other node lists as a child.
 *
 * A cyclic `children` graph can leave every node claimed and so produce NO roots; the caller would
 * then import nothing at all, which is worse than importing it un-parented, so a graph with no root
 * falls back to every node (the cycle guard in the walk still bounds it).
 */
function rootNodeIndexes(nodes: readonly GltfNode[]): number[] {
  const claimed = new Set<number>()
  for (const node of nodes) for (const child of node.children ?? []) claimed.add(child)
  const roots = nodes.flatMap((_, index) => (claimed.has(index) ? [] : [index]))
  return roots.length > 0 ? roots : nodes.map((_, index) => index)
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/**
 * A node's own transform: either an explicit column-major `matrix`, or the TRS triple composed as
 * translation x rotation x scale, which is the order the spec mandates.
 */
function localMatrix(node: GltfNode): number[] {
  if (node.matrix && node.matrix.length === 16) return [...node.matrix]
  const [tx, ty, tz] = node.translation ?? [0, 0, 0]
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1]
  const [sx, sy, sz] = node.scale ?? [1, 1, 1]
  // Quaternion to a column-major rotation basis, then scaled per column.
  const x2 = qx! + qx!, y2 = qy! + qy!, z2 = qz! + qz!
  const xx = qx! * x2, xy = qx! * y2, xz = qx! * z2
  const yy = qy! * y2, yz = qy! * z2, zz = qz! * z2
  const wx = qw! * x2, wy = qw! * y2, wz = qw! * z2
  return [
    (1 - (yy + zz)) * sx!, (xy + wz) * sx!, (xz - wy) * sx!, 0,
    (xy - wz) * sy!, (1 - (xx + zz)) * sy!, (yz + wx) * sy!, 0,
    (xz + wy) * sz!, (yz - wx) * sz!, (1 - (xx + yy)) * sz!, 0,
    tx!, ty!, tz!, 1
  ]
}

/** Column-major 4x4 multiply, `a` applied after `b` (i.e. parent x local). */
function multiply(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0)
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row]! * b[column * 4 + k]!
      out[column * 4 + row] = sum
    }
  }
  return out
}

/**
 * Whether a node's transform flips handedness, i.e. the determinant of its 3x3 linear part is
 * negative. Exactly the condition under which baked geometry needs its winding reversed.
 */
function matrixMirrors(matrix: readonly number[]): boolean {
  const [a, b, c, , d, e, f, , g, h, i] = matrix
  const determinant = a! * (e! * i! - f! * h!) - d! * (b! * i! - c! * h!) + g! * (b! * f! - c! * e!)
  return determinant < 0
}

/** Swap the last two corners of every triangle, restoring outward-facing winding after a mirror. */
function reverseTriangleWinding(indices: number[]): void {
  for (let triangle = 0; triangle + 2 < indices.length; triangle += 3) {
    const swap = indices[triangle + 1]!
    indices[triangle + 1] = indices[triangle + 2]!
    indices[triangle + 2] = swap
  }
}

/**
 * Bake a node's world matrix into its vertices, in place.
 *
 * The translation column is scaled to millimetres alongside the coordinates it moves; the rotation
 * and scale columns are NOT, being dimensionless. Scaling the whole matrix would cube the model.
 */
function applyNodeMatrix(positions: number[], matrix: readonly number[]): void {
  if (matrix.every((value, index) => value === IDENTITY[index])) return
  for (let index = 0; index + 2 < positions.length; index += 3) {
    const x = positions[index]!, y = positions[index + 1]!, z = positions[index + 2]!
    positions[index] = matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]! * GLTF_MILLIMETRES_PER_UNIT
    positions[index + 1] = matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]! * GLTF_MILLIMETRES_PER_UNIT
    positions[index + 2] = matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]! * GLTF_MILLIMETRES_PER_UNIT
  }
}

// ---------------------------------------------------------------------------------------------
// The slice of the glTF schema this reads. Deliberately structural rather than validated with Zod:
// every field is optional in the spec, the failure modes that matter are bounds (handled above), and
// a schema over the whole document would reject files the spec allows and we can read.

export interface GltfDocument {
  scene?: number
  scenes?: Array<{ nodes?: number[] }>
  nodes?: GltfNode[]
  meshes?: Array<{ name?: string; primitives?: GltfPrimitive[] }>
  accessors?: GltfAccessor[]
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength?: number; byteStride?: number }>
  buffers?: Array<{ uri?: string; byteLength?: number }>
  images?: GltfImage[]
  textures?: Array<{
    source?: number
    sampler?: number
    extensions?: { KHR_texture_basisu?: unknown; EXT_texture_webp?: unknown }
  }>
  samplers?: Array<{ wrapS?: number; wrapT?: number }>
  materials?: Array<{ pbrMetallicRoughness?: GltfPbrMaterial }>
}

interface GltfImage {
  uri?: string
  bufferView?: number
  mimeType?: string
}

interface GltfPbrMaterial {
  baseColorFactor?: number[]
  baseColorTexture?: GltfTextureInfo
}

interface GltfTextureInfo {
  index: number
  texCoord?: number
  extensions?: { KHR_texture_transform?: GltfTextureTransform }
}

export interface GltfTextureTransform {
  offset?: number[]
  rotation?: number
  scale?: number[]
  texCoord?: number
}

interface GltfNode {
  mesh?: number
  name?: string
  children?: number[]
  matrix?: number[]
  translation?: number[]
  rotation?: number[]
  scale?: number[]
}

export interface GltfPrimitive {
  attributes?: Record<string, number>
  indices?: number
  mode?: number
  extensions?: Record<string, unknown>
  material?: number
}

interface GltfAccessor {
  bufferView?: number
  byteOffset?: number
  componentType: number
  count: number
  type: string
  sparse?: unknown
  normalized?: boolean
}
