/**
 * glTF base-colour texture and material handling.
 *
 * The main glTF parser owns containers, geometry accessors, and scene transforms. This module owns
 * the printable appearance layered onto that geometry: resolving embedded PNG/JPEG resources,
 * applying base-colour factors and texture transforms, and producing triangles for the shared
 * texture sampler. Hosts still provide the actual image decoder.
 */
import { ModelImportError } from './imported-mesh.js'
import type { DecodedTextureImage, TexturedTriangle, TextureWrapMode } from './mesh-texture.js'
import { MAX_MODEL_TEXTURE_PIXELS } from './texture-resources.js'
import type { GltfDocument, GltfPrimitive, GltfTextureTransform } from './mesh-gltf.js'

const MODE_TRIANGLES = 4

export interface GltfPrimitiveAppearance {
  factor: [number, number, number, number]
  hasExplicitFactor: boolean
  texture?: DecodedTextureImage
  uvs?: number[]
  wrapU?: TextureWrapMode
  wrapV?: TextureWrapMode
}

/** Resolve a primitive's printable base colour and decoded texture, if present. */
export function gltfPrimitiveAppearance(
  json: GltfDocument,
  buffers: Uint8Array[],
  primitive: GltfPrimitive,
  vertexCount: number,
  decodedImages: ReadonlyMap<number, DecodedTextureImage> | undefined,
  readTextureCoordinates: (json: GltfDocument, buffers: Uint8Array[], accessorIndex: number) => number[]
): GltfPrimitiveAppearance | null {
  const material = primitive.material == null ? undefined : (json.materials ?? [])[primitive.material]
  if (!material) return null
  const pbr = material.pbrMetallicRoughness
  const factor = normalizedColorFactor(pbr?.baseColorFactor)
  const textureInfo = pbr?.baseColorTexture
  if (!textureInfo) return { factor, hasExplicitFactor: pbr?.baseColorFactor != null }
  const source = gltfTextureSource(json, textureInfo.index)
  const image = source == null ? undefined : decodedImages?.get(source)
  if (!image) return { factor, hasExplicitFactor: pbr?.baseColorFactor != null }

  const transform = textureInfo.extensions?.KHR_texture_transform
  const texCoord = transform?.texCoord ?? textureInfo.texCoord ?? 0
  const accessor = primitive.attributes?.[`TEXCOORD_${texCoord}`]
  if (accessor == null) throw new ModelImportError('glTF textured primitive is missing texture coordinates')
  const uvs = readTextureCoordinates(json, buffers, accessor)
  if (uvs.length !== vertexCount * 2) throw new ModelImportError('glTF texture coordinates do not match its positions')
  applyTextureTransform(uvs, transform)
  const wrapping = gltfTextureWrapping(json, textureInfo.index)
  return { factor, hasExplicitFactor: pbr?.baseColorFactor != null, texture: image, uvs, ...wrapping }
}

/** Convert indexed glTF geometry and UVs into input for the shared texture sampler. */
export function texturedTrianglesFromGltfPrimitive(
  positions: readonly number[],
  indices: readonly number[],
  uvs: readonly number[],
  texture: DecodedTextureImage,
  factor: readonly [number, number, number, number],
  wrapping: { wrapU?: TextureWrapMode; wrapV?: TextureWrapMode } = {}
): TexturedTriangle[] {
  const triangles: TexturedTriangle[] = []
  for (let offset = 0; offset + 2 < indices.length; offset += 3) {
    const corners = [indices[offset]!, indices[offset + 1]!, indices[offset + 2]!] as const
    triangles.push({
      positions: [meshPoint(positions, corners[0]), meshPoint(positions, corners[1]), meshPoint(positions, corners[2])],
      uvs: [texturePoint(uvs, corners[0]), texturePoint(uvs, corners[1]), texturePoint(uvs, corners[2])],
      texture,
      textureFactor: factor,
      ...wrapping
    })
  }
  return triangles
}

function gltfTextureWrapping(
  json: GltfDocument,
  textureIndex: number
): { wrapU: TextureWrapMode; wrapV: TextureWrapMode } {
  const texture = (json.textures ?? [])[textureIndex]
  const sampler = texture?.sampler == null ? undefined : (json.samplers ?? [])[texture.sampler]
  return {
    wrapU: gltfWrapMode(sampler?.wrapS),
    wrapV: gltfWrapMode(sampler?.wrapT)
  }
}

function gltfWrapMode(value: number | undefined): TextureWrapMode {
  if (value == null || value === 10497) return 'repeat'
  if (value === 33071) return 'clamp'
  if (value === 33648) return 'mirrored-repeat'
  throw new ModelImportError('glTF texture uses an invalid wrapping mode')
}

/** Count decoded textured primitive instances so the parser can share its subdivision target. */
export function countTexturedGltfPrimitiveInstances(
  json: GltfDocument,
  nodes: readonly { mesh: number }[],
  decodedImages: ReadonlyMap<number, DecodedTextureImage> | undefined
): number {
  if (!decodedImages || decodedImages.size === 0) return 0
  let count = 0
  for (const node of nodes) {
    for (const primitive of (json.meshes ?? [])[node.mesh]?.primitives ?? []) {
      if (!isPrintableGltfPrimitive(primitive)) continue
      const info = primitive.material == null
        ? undefined
        : (json.materials ?? [])[primitive.material]?.pbrMetallicRoughness?.baseColorTexture
      const source = info == null ? undefined : gltfTextureSource(json, info.index)
      const texCoord = info?.extensions?.KHR_texture_transform?.texCoord ?? info?.texCoord ?? 0
      if (source != null && decodedImages.has(source) && primitive.attributes?.[`TEXCOORD_${texCoord}`] != null) count += 1
    }
  }
  return count
}

/** Decode only embedded images reached by printable primitives in the active scene. */
export async function decodeReferencedGltfTextureImages(
  json: GltfDocument,
  buffers: Uint8Array[],
  nodes: readonly { mesh: number }[],
  decodeTexture: (name: string, bytes: Uint8Array) => Promise<DecodedTextureImage> | DecodedTextureImage
): Promise<Map<number, DecodedTextureImage>> {
  const sources = referencedGltfImageSources(json, nodes)
  const decoded = new Map<number, DecodedTextureImage>()
  let decodedPixels = 0
  for (const source of sources) {
    const image = (json.images ?? [])[source]
    if (!image) throw new ModelImportError('glTF file is missing a texture image')
    const resource = gltfImageResource(json, buffers, image, source)
    const pixels = await decodeTexture(resource.name, resource.bytes)
    decodedPixels += pixels.width * pixels.height
    if (decodedPixels > MAX_MODEL_TEXTURE_PIXELS) {
      throw new ModelImportError('glTF textures exceed the decoded pixel limit')
    }
    decoded.set(source, pixels)
  }
  return decoded
}

/** Decode a `data:` URI without relying on Node's Buffer in browser consumers. */
export function decodeGltfDataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(',')
  if (comma < 0) throw new ModelImportError('glTF file could not be read')
  const payload = uri.slice(comma + 1)
  try {
    if (!/;base64$/i.test(uri.slice(0, comma))) {
      return new TextEncoder().encode(decodeURIComponent(payload))
    }
    const binary = atob(payload)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    throw new ModelImportError('glTF file could not be read')
  }
}

function referencedGltfImageSources(json: GltfDocument, nodes: readonly { mesh: number }[]): Set<number> {
  const sources = new Set<number>()
  for (const node of nodes) {
    for (const primitive of (json.meshes ?? [])[node.mesh]?.primitives ?? []) {
      if (!isPrintableGltfPrimitive(primitive)) continue
      const info = primitive.material == null
        ? undefined
        : (json.materials ?? [])[primitive.material]?.pbrMetallicRoughness?.baseColorTexture
      const source = info == null ? undefined : gltfTextureSource(json, info.index)
      if (source != null) sources.add(source)
    }
  }
  return sources
}

const isPrintableGltfPrimitive = (primitive: GltfPrimitive): boolean =>
  (primitive.mode ?? MODE_TRIANGLES) === MODE_TRIANGLES && primitive.attributes?.POSITION != null

/** Resolve a core PNG/JPEG source, refusing extension-only codecs instead of dropping colour. */
function gltfTextureSource(json: GltfDocument, textureIndex: number): number | undefined {
  const texture = (json.textures ?? [])[textureIndex]
  if (!texture) throw new ModelImportError('glTF file is missing a texture')
  if (texture.source != null) return texture.source
  if (texture.extensions?.KHR_texture_basisu != null) {
    throw new ModelImportError('This glTF uses a Basis Universal texture, which cannot be imported')
  }
  if (texture.extensions?.EXT_texture_webp != null) {
    throw new ModelImportError('This glTF uses a WebP texture without a PNG/JPEG fallback, which cannot be imported')
  }
  throw new ModelImportError('glTF file is missing a texture image')
}

function gltfImageResource(
  json: GltfDocument,
  buffers: Uint8Array[],
  image: NonNullable<GltfDocument['images']>[number],
  index: number
): { name: string; bytes: Uint8Array } {
  if (image.uri != null) {
    if (!image.uri.startsWith('data:')) {
      throw new ModelImportError('This glTF refers to a separate image file, so only a self-contained .glb or .gltf can import textures')
    }
    const mime = /^data:([^;,]+)/i.exec(image.uri)?.[1]?.toLowerCase() ?? ''
    return { name: gltfImageName(index, mime), bytes: decodeGltfDataUri(image.uri) }
  }
  const view = image.bufferView == null ? undefined : (json.bufferViews ?? [])[image.bufferView]
  const buffer = view ? buffers[view.buffer] : undefined
  if (!view || !buffer) throw new ModelImportError('glTF file is missing a texture image')
  const start = view.byteOffset ?? 0
  const length = view.byteLength ?? 0
  if (start < 0 || length < 1 || start + length > buffer.byteLength) throw new ModelImportError('glTF texture image is truncated')
  return { name: gltfImageName(index, image.mimeType), bytes: buffer.subarray(start, start + length) }
}

function gltfImageName(index: number, mimeType: string | undefined): string {
  const normalized = mimeType?.toLowerCase()
  if (normalized === 'image/png') return `texture-${index}.png`
  if (normalized === 'image/jpeg') return `texture-${index}.jpg`
  throw new ModelImportError('glTF texture must be PNG or JPEG')
}

function normalizedColorFactor(value: readonly number[] | undefined): [number, number, number, number] {
  if (value == null) return [1, 1, 1, 1]
  if (value.length !== 4 || value.some((channel) => !Number.isFinite(channel))) {
    throw new ModelImportError('glTF contains an invalid base colour factor')
  }
  // Filament paint is opaque, so glTF alpha cannot erase an otherwise printable base colour.
  return [
    Math.max(0, Math.min(1, value[0]!)),
    Math.max(0, Math.min(1, value[1]!)),
    Math.max(0, Math.min(1, value[2]!)),
    1
  ]
}

function applyTextureTransform(uvs: number[], transform: GltfTextureTransform | undefined): void {
  if (!transform) return
  const [offsetU, offsetV] = transform.offset ?? [0, 0]
  const [scaleU, scaleV] = transform.scale ?? [1, 1]
  const rotation = transform.rotation ?? 0
  if (![offsetU, offsetV, scaleU, scaleV, rotation].every(Number.isFinite)) {
    throw new ModelImportError('glTF contains an invalid texture transform')
  }
  const cosine = Math.cos(rotation)
  const sine = Math.sin(rotation)
  for (let index = 0; index + 1 < uvs.length; index += 2) {
    const u = uvs[index]! * scaleU!
    const v = uvs[index + 1]! * scaleV!
    uvs[index] = offsetU! + cosine * u - sine * v
    uvs[index + 1] = offsetV! + sine * u + cosine * v
  }
}

const meshPoint = (positions: readonly number[], vertex: number): readonly [number, number, number] => [
  positions[vertex * 3]!, positions[vertex * 3 + 1]!, positions[vertex * 3 + 2]!
]
const texturePoint = (uvs: readonly number[], vertex: number): readonly [number, number] => [
  uvs[vertex * 2]!, uvs[vertex * 2 + 1]!
]
