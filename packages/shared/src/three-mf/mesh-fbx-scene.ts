/**
 * FBX scene flattening: turn the scene graph produced by each host's lazy FBX loader into the
 * dependency-free {@link ImportedMesh} contract used by the editor and 3MF writer.
 *
 * The API and browser deliberately own their own FBX LOADING because this shared package must stay
 * Node-free, DOM-free, and free of Three.js. They both hand the resulting structural scene here so
 * transforms, winding, validation, part naming, triangle limits, and unit conversion cannot drift.
 *
 * FBX stores `UnitScaleFactor` in centimetres per file unit. The host parser supplies that value and
 * this module converts every coordinate to millimetres. Missing values use the FBX default of one
 * centimetre per unit.
 */
import { ModelImportError, type ImportedMesh, type ImportedMeshPart } from './imported-mesh.js'
import {
  assertImportTriangleBudget,
  computeMeshBounds,
  MAX_IMPORT_TRIANGLES,
  mergeImportedMeshes,
  weldImportedMeshVertices
} from './mesh-stl.js'
import {
  sampleTexturedTriangles,
  type DecodedTextureImage,
  type TexturedTriangle,
  type TextureWrapMode
} from './mesh-texture.js'

/** The narrow scene shape consumed from Three.js without importing Three.js into this package. */
export interface FbxSceneNode {
  name?: string
  children?: readonly FbxSceneNode[]
  isMesh?: boolean
  isSkinnedMesh?: boolean
  geometry?: {
    attributes?: {
      position?: {
        array: ArrayLike<number>
        count: number
        itemSize: number
      }
      uv?: {
        array: ArrayLike<number>
        count: number
        itemSize: number
      }
    }
    index?: {
      array: ArrayLike<number>
      count: number
    } | null
    groups?: Array<{ start: number; count: number; materialIndex?: number }>
  }
  matrixWorld?: {
    elements: ArrayLike<number>
  }
  material?: FbxSceneMaterial | readonly FbxSceneMaterial[]
}

export interface FbxSceneMaterial {
  name?: string
  color?: { r: number; g: number; b: number }
  map?: FbxSceneTexture | null
}

export interface FbxSceneTexture {
  image?: { src?: string }
  offset?: { x: number; y: number }
  repeat?: { x: number; y: number }
  wrapS?: number
  wrapT?: number
}

export interface FbxTextureReference {
  texture: FbxSceneTexture
  source: string
}

export interface FbxSceneImportOptions {
  /** Decoded diffuse images keyed by the Three.js texture object that references them. */
  decodedTextures?: ReadonlyMap<object, DecodedTextureImage>
}

/** Find each diffuse texture actually attached to an imported mesh, once per texture object. */
export function referencedFbxTextures(root: FbxSceneNode): FbxTextureReference[] {
  const references: FbxTextureReference[] = []
  const seen = new Set<object>()
  visit(root, (node) => {
    if (!node.isMesh) return
    const materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : []
    for (const material of materials) {
      const texture = material.map
      if (!texture || seen.has(texture as object)) continue
      seen.add(texture as object)
      const source = texture.image?.src
      if (source) references.push({ texture, source })
    }
  })
  return references
}

/**
 * Flatten an FBX loader scene into millimetre triangle meshes.
 *
 * Skinned meshes are refused rather than imported in their undeformed bind pose. Animation and
 * rigging have no 3MF representation, and silently baking the wrong pose would be data corruption.
 */
export function importedMeshFromFbxScene(
  root: FbxSceneNode,
  unitScaleFactor = 1,
  options: FbxSceneImportOptions = {}
): ImportedMesh {
  if (!Number.isFinite(unitScaleFactor) || unitScaleFactor <= 0) {
    throw new ModelImportError('FBX declares an invalid unit scale')
  }
  const millimetresPerUnit = unitScaleFactor * 10
  const parts: ImportedMeshPart[] = []
  const texturedMeshCount = countTexturedMeshes(root, options.decodedTextures)
  const textureTarget = texturedMeshCount > 0 ? Math.ceil(10_000 / texturedMeshCount) : 0
  let outputTriangleCount = 0
  visit(root, (node) => {
    if (!node.isMesh) return
    if (node.isSkinnedMesh) {
      throw new ModelImportError('Skinned FBX meshes are not supported; apply the model pose before exporting')
    }
    const mesh = meshFromNode(node, millimetresPerUnit, options.decodedTextures, {
      targetTriangles: textureTarget,
      maxTriangles: Math.max(1, MAX_IMPORT_TRIANGLES - outputTriangleCount)
    })
    if (mesh.indices.length === 0) return
    outputTriangleCount += mesh.indices.length / 3
    assertImportTriangleBudget(outputTriangleCount)
    parts.push({ name: node.name?.trim() || `Part ${parts.length + 1}`, mesh })
  })

  if (parts.length === 0) throw new ModelImportError('FBX contained no triangles')
  const merged = mergeImportedMeshes(parts.map((part) => part.mesh))
  assertImportTriangleBudget(merged.indices.length / 3)
  return parts.length > 1 ? { ...merged, parts } : merged
}

/** Read the FBX `UnitScaleFactor`, returning the format default when it is absent. */
export function readFbxUnitScaleFactor(bytes: Uint8Array): number {
  const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 27)))
  return prefix.startsWith('Kaydara FBX Binary')
    ? readBinaryUnitScaleFactor(bytes) ?? 1
    : readAsciiUnitScaleFactor(bytes) ?? 1
}

/**
 * Protect ASCII FBX files from Three.js's brittle binary-signature exclusion.
 *
 * Its ASCII detector samples triangular offsets and rejects the file when ANY sampled character
 * happens to equal the corresponding binary-signature character. A valid file can therefore fail
 * based on unrelated metadata length. A long legal comment makes every sampled byte deterministic;
 * binary files are passed through unchanged.
 */
export function prepareFbxLoaderBytes(bytes: Uint8Array): Uint8Array {
  const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 23)))
  if (prefix.startsWith('Kaydara FBX Binary')) return bytes
  const guard = new TextEncoder().encode(`;${'~'.repeat(256)}\n`)
  const guarded = new Uint8Array(guard.length + bytes.length)
  guarded.set(guard)
  guarded.set(bytes, guard.length)
  return guarded
}

function visit(node: FbxSceneNode, visitor: (node: FbxSceneNode) => void): void {
  visitor(node)
  for (const child of node.children ?? []) visit(child, visitor)
}

function meshFromNode(
  node: FbxSceneNode,
  scale: number,
  decodedTextures: ReadonlyMap<object, DecodedTextureImage> | undefined,
  textureBudget: { targetTriangles: number; maxTriangles: number }
): ImportedMesh {
  const attribute = node.geometry?.attributes?.position
  if (!attribute || attribute.itemSize < 3 || attribute.count <= 0) {
    return { positions: [], indices: [], bounds: computeMeshBounds([]) }
  }
  const matrix = node.matrixWorld?.elements
  if (!matrix || matrix.length < 16) throw new ModelImportError('FBX mesh has no world transform')

  const positions: number[] = []
  for (let vertex = 0; vertex < attribute.count; vertex += 1) {
    const offset = vertex * attribute.itemSize
    const x = Number(attribute.array[offset])
    const y = Number(attribute.array[offset + 1])
    const z = Number(attribute.array[offset + 2])
    if (![x, y, z].every(Number.isFinite)) throw new ModelImportError('FBX contains an invalid vertex')
    const w = (matrix[3] ?? 0) * x + (matrix[7] ?? 0) * y + (matrix[11] ?? 0) * z + (matrix[15] ?? 1)
    const divisor = w === 0 ? 1 : w
    positions.push(
      (((matrix[0] ?? 0) * x + (matrix[4] ?? 0) * y + (matrix[8] ?? 0) * z + (matrix[12] ?? 0)) / divisor) * scale,
      (((matrix[1] ?? 0) * x + (matrix[5] ?? 0) * y + (matrix[9] ?? 0) * z + (matrix[13] ?? 0)) / divisor) * scale,
      (((matrix[2] ?? 0) * x + (matrix[6] ?? 0) * y + (matrix[10] ?? 0) * z + (matrix[14] ?? 0)) / divisor) * scale
    )
  }

  const sourceIndices = node.geometry?.index
  const indices = sourceIndices
    ? Array.from({ length: sourceIndices.count }, (_, index) => Number(sourceIndices.array[index]))
    : Array.from({ length: attribute.count }, (_, index) => index)
  if (indices.length % 3 !== 0) throw new ModelImportError('FBX mesh is not triangulated')
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= attribute.count) {
      throw new ModelImportError('FBX contains an invalid triangle index')
    }
  }
  assertImportTriangleBudget(indices.length / 3)
  if (matrixDeterminant3(matrix) < 0) reverseTriangleWinding(indices)

  const appearance = meshAppearance(node, positions, indices, decodedTextures)
  if (appearance.texturedTriangles) {
    return sampleTexturedTriangles(appearance.texturedTriangles, textureBudget)
  }
  return weldImportedMeshVertices({
    positions,
    indices,
    bounds: computeMeshBounds(positions),
    ...(appearance.triangleCornerColors
      ? { triangleCornerColors: appearance.triangleCornerColors, sourceColorMode: 'material' as const }
      : {})
  })
}

function meshAppearance(
  node: FbxSceneNode,
  positions: readonly number[],
  indices: readonly number[],
  decodedTextures: ReadonlyMap<object, DecodedTextureImage> | undefined
): { texturedTriangles?: TexturedTriangle[]; triangleCornerColors?: number[] } {
  const materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : []
  if (materials.length === 0) return {}
  const uv = node.geometry?.attributes?.uv
  const hasDecodedTexture = materials.some((material) => material.map && decodedTextures?.has(material.map as object))
  if (hasDecodedTexture && (
    !uv ||
    uv.itemSize < 2 ||
    uv.count !== positions.length / 3 ||
    (uv.count - 1) * uv.itemSize + 2 > uv.array.length
  )) {
    throw new ModelImportError('FBX textured mesh is missing texture coordinates')
  }

  const triangles: TexturedTriangle[] = []
  const flatColors: number[] = []
  let hasFlatColor = false
  for (let offset = 0; offset < indices.length; offset += 3) {
    const material = materialAt(node, materials, offset)
    const color = materialColor(material)
    const textureMap = material?.map
    const texture = textureMap ? decodedTextures?.get(textureMap as object) : undefined
    if (texture && uv) {
      const corners = [indices[offset]!, indices[offset + 1]!, indices[offset + 2]!] as const
      triangles.push({
        positions: [
          meshPoint(positions, corners[0]),
          meshPoint(positions, corners[1]),
          meshPoint(positions, corners[2])
        ],
        uvs: [
          texturePoint(uv, corners[0], textureMap!),
          texturePoint(uv, corners[1], textureMap!),
          texturePoint(uv, corners[2], textureMap!)
        ],
        texture,
        textureFactor: color,
        wrapU: fbxWrapMode(textureMap?.wrapS),
        wrapV: fbxWrapMode(textureMap?.wrapT),
        // FBXLoader keeps Three.js's default flipY texture convention. Apply it after wrapping.
        flipV: true
      })
    } else {
      triangles.push({
        positions: [
          meshPoint(positions, indices[offset]!),
          meshPoint(positions, indices[offset + 1]!),
          meshPoint(positions, indices[offset + 2]!)
        ],
        fallbackColor: color
      })
    }
    if (material?.color && material.name !== '__DEFAULT') hasFlatColor = true
    for (let corner = 0; corner < 3; corner += 1) flatColors.push(...color)
  }
  return hasDecodedTexture
    ? { texturedTriangles: triangles }
    : hasFlatColor ? { triangleCornerColors: flatColors } : {}
}

function materialAt(
  node: FbxSceneNode,
  materials: readonly FbxSceneMaterial[],
  indexOffset: number
): FbxSceneMaterial | undefined {
  const group = node.geometry?.groups?.find(({ start, count }) => indexOffset >= start && indexOffset < start + count)
  return materials[group?.materialIndex ?? 0] ?? materials[0]
}

function materialColor(material: FbxSceneMaterial | undefined): [number, number, number, number] {
  const color = material?.color
  if (color && ![color.r, color.g, color.b].every(Number.isFinite)) {
    throw new ModelImportError('FBX contains an invalid diffuse material colour')
  }
  return color
    ? [linearToSrgb(color.r), linearToSrgb(color.g), linearToSrgb(color.b), 1]
    : [1, 1, 1, 1]
}

function linearToSrgb(value: number): number {
  const clamped = Math.max(0, Math.min(1, value))
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055
}

function meshPoint(positions: readonly number[], vertex: number): readonly [number, number, number] {
  return [positions[vertex * 3]!, positions[vertex * 3 + 1]!, positions[vertex * 3 + 2]!]
}

function texturePoint(
  uv: NonNullable<NonNullable<FbxSceneNode['geometry']>['attributes']>['uv'],
  vertex: number,
  texture: FbxSceneTexture
): readonly [number, number] {
  const at = vertex * uv!.itemSize
  const repeat = texture.repeat ?? { x: 1, y: 1 }
  const offset = texture.offset ?? { x: 0, y: 0 }
  const u = (Number(uv!.array[at]) * repeat.x) + offset.x
  const v = (Number(uv!.array[at + 1]) * repeat.y) + offset.y
  if (![u, v].every(Number.isFinite)) throw new ModelImportError('FBX contains invalid texture coordinates')
  return [u, v]
}

function fbxWrapMode(value: number | undefined): TextureWrapMode {
  if (value == null || value === 1000) return 'repeat'
  if (value === 1001) return 'clamp'
  if (value === 1002) return 'mirrored-repeat'
  throw new ModelImportError('FBX texture uses an invalid wrapping mode')
}

function countTexturedMeshes(
  root: FbxSceneNode,
  decodedTextures: ReadonlyMap<object, DecodedTextureImage> | undefined
): number {
  if (!decodedTextures || decodedTextures.size === 0) return 0
  let count = 0
  visit(root, (node) => {
    if (!node.isMesh || !node.geometry?.attributes?.uv) return
    const materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : []
    if (materials.some((material) => material.map && decodedTextures.has(material.map as object))) count += 1
  })
  return count
}

function matrixDeterminant3(matrix: ArrayLike<number>): number {
  const a = matrix[0] ?? 0
  const b = matrix[4] ?? 0
  const c = matrix[8] ?? 0
  const d = matrix[1] ?? 0
  const e = matrix[5] ?? 0
  const f = matrix[9] ?? 0
  const g = matrix[2] ?? 0
  const h = matrix[6] ?? 0
  const i = matrix[10] ?? 0
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
}

function reverseTriangleWinding(indices: number[]): void {
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const second = indices[triangle + 1]!
    indices[triangle + 1] = indices[triangle + 2]!
    indices[triangle + 2] = second
  }
}

function readAsciiUnitScaleFactor(bytes: Uint8Array): number | null {
  const text = new TextDecoder().decode(bytes)
  const match = /P:\s*"UnitScaleFactor"\s*,\s*"double"\s*,\s*"Number"\s*,\s*""\s*,\s*([-+\d.eE]+)/.exec(text)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

/**
 * Read the standard binary `P: "UnitScaleFactor", "double", "Number", "", D` property sequence.
 * This intentionally does not parse the whole FBX tree; the maintained loader owns that job.
 */
function readBinaryUnitScaleFactor(bytes: Uint8Array): number | null {
  const marker = new TextEncoder().encode('UnitScaleFactor')
  const start = indexOfBytes(bytes, marker)
  if (start < 0) return null
  let offset = start + marker.length
  for (const expected of ['double', 'Number', '']) {
    const value = readBinaryStringProperty(bytes, offset)
    if (!value || value.value !== expected) return null
    offset = value.next
  }
  if (bytes[offset] !== 68 || offset + 9 > bytes.length) return null // `D`, then float64 LE
  return new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 8).getFloat64(0, true)
}

function readBinaryStringProperty(bytes: Uint8Array, offset: number): { value: string; next: number } | null {
  if (bytes[offset] !== 83 || offset + 5 > bytes.length) return null // `S`, then uint32 length
  const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0, true)
  const start = offset + 5
  if (start + length > bytes.length) return null
  return { value: new TextDecoder().decode(bytes.subarray(start, start + length)), next: start + length }
}

function indexOfBytes(bytes: Uint8Array, needle: Uint8Array): number {
  outer: for (let offset = 0; offset + needle.length <= bytes.length; offset += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (bytes[offset + index] !== needle[index]) continue outer
    }
    return offset
  }
  return -1
}
