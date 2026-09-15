/**
 * Dependency-free texture sampling for mesh imports.
 *
 * Hosts decode image bytes into RGBA pixels, then this module performs the geometry-shaped work
 * shared by the API and browser: repeat-wrapped bilinear sampling, BambuStudio's seven-point face
 * quadrature, and bounded linear subdivision for low-poly textured models. Keeping decoding out of
 * shared lets Node use small image codecs while the browser uses its native bitmap decoder.
 */
import { assertImportTriangleBudget, computeMeshBounds, MAX_IMPORT_TRIANGLES, weldImportedMeshVertices } from './mesh-stl.js'
import type { ImportedMesh } from './imported-mesh.js'

export interface DecodedTextureImage {
  width: number
  height: number
  /** Row-major RGBA bytes, with the first row at the top of the image. */
  rgba: Uint8Array
}

export interface TexturedTriangle {
  positions: readonly [Vec3, Vec3, Vec3]
  /** UVs use the source format's convention; set `flipV` when V=0 addresses the image bottom. */
  uvs?: readonly [Vec2, Vec2, Vec2]
  texture?: DecodedTextureImage
  wrapU?: TextureWrapMode
  wrapV?: TextureWrapMode
  flipV?: boolean
  /** Per-channel multiplier, such as glTF's `baseColorFactor`. */
  textureFactor?: Rgba
  fallbackColor?: readonly [number, number, number, number]
  /** Optional per-corner fallback colours, interpolated through subdivision. */
  cornerColors?: readonly [Rgba, Rgba, Rgba]
}

type Vec2 = readonly [number, number]
type Vec3 = readonly [number, number, number]
type Rgba = readonly [number, number, number, number]
export type TextureWrapMode = 'repeat' | 'clamp' | 'mirrored-repeat'

const TARGET_TEXTURE_TRIANGLES = 10_000
const GAUSS_BARYCENTRIC: ReadonlyArray<readonly [number, number, number, number]> = [
  [1 / 3, 1 / 3, 1 / 3, 0.225],
  [0.059715871, 0.470142064, 0.470142064, 0.132394152],
  [0.470142064, 0.059715871, 0.470142064, 0.132394152],
  [0.470142064, 0.470142064, 0.059715871, 0.132394152],
  [0.797426985, 0.101286507, 0.101286507, 0.125939181],
  [0.101286507, 0.797426985, 0.101286507, 0.125939181],
  [0.101286507, 0.101286507, 0.797426985, 0.125939181]
]

/**
 * Convert textured triangles to a welded mesh with one sampled RGBA value per resulting face.
 *
 * Low-poly input is subdivided uniformly until it reaches roughly 10,000 faces, matching
 * BambuStudio's adaptive oversampling default. Subdivision stops before the global import ceiling.
 * Untextured faces are subdivided alongside textured neighbours so triangle and paint ordering
 * remain one stable sequence.
 */
export function sampleTexturedTriangles(
  triangles: readonly TexturedTriangle[],
  options: { targetTriangles?: number; maxTriangles?: number } = {}
): ImportedMesh {
  const targetTriangles = options.targetTriangles ?? TARGET_TEXTURE_TRIANGLES
  const maxTriangles = options.maxTriangles ?? MAX_IMPORT_TRIANGLES
  let sampled = [...triangles]
  while (sampled.length < targetTriangles && sampled.length * 4 <= maxTriangles) {
    sampled = sampled.flatMap(subdivideTriangle)
  }
  assertImportTriangleBudget(sampled.length)

  const positions: number[] = []
  const indices: number[] = []
  const triangleCornerColors: number[] = []
  for (const triangle of sampled) {
    const color = sampledTriangleColor(triangle)
    for (const position of triangle.positions) {
      indices.push(positions.length / 3)
      positions.push(...position)
      triangleCornerColors.push(...color)
    }
  }

  return weldImportedMeshVertices({
    positions,
    indices,
    bounds: computeMeshBounds(positions),
    triangleCornerColors,
    sourceColorMode: 'texture'
  })
}

/** Texture wins; otherwise retain an interpolated source colour or the material fallback. */
function sampledTriangleColor(triangle: TexturedTriangle): readonly [number, number, number, number] {
  if (triangle.texture && triangle.uvs) {
    const sampled = sampleFaceColor(
      triangle.uvs,
      triangle.texture,
      triangle.wrapU ?? 'repeat',
      triangle.wrapV ?? 'repeat',
      triangle.flipV ?? false
    )
    return triangle.textureFactor
      ? sampled.map((channel, index) => channel * triangle.textureFactor![index]!) as [number, number, number, number]
      : sampled
  }
  if (triangle.cornerColors) return averageColors(triangle.cornerColors)
  return triangle.fallbackColor ?? [0, 0, 0, 0]
}

/** Sample a repeat-wrapped texture with bilinear filtering. */
export function sampleTexturePixel(
  image: DecodedTextureImage,
  u: number,
  v: number,
  wrapU: TextureWrapMode = 'repeat',
  wrapV: TextureWrapMode = 'repeat',
  flipV = false
): [number, number, number, number] {
  if (image.width < 1 || image.height < 1 || image.rgba.length !== image.width * image.height * 4) {
    throw new Error('Decoded texture pixels do not match its dimensions')
  }
  const wrappedU = wrapTextureCoordinate(u, wrapU)
  const wrappedV = wrapTextureCoordinate(v, wrapV)
  const x = wrappedU * (image.width - 1)
  // Origin conversion follows wrapping. Pre-flipping `v` makes an exact repeat seam (0/1) wrap
  // back to the opposite source row, which inverted the edge pixels of OBJ and FBX textures.
  const y = (flipV ? 1 - wrappedV : wrappedV) * (image.height - 1)
  const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(x)))
  const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(y)))
  const x1 = Math.min(x0 + 1, image.width - 1)
  const y1 = Math.min(y0 + 1, image.height - 1)
  const wx = x - x0
  const wy = y - y0
  const result = [0, 0, 0, 0]
  for (let channel = 0; channel < 4; channel += 1) {
    const top = byteAt(image, x0, y0, channel) * (1 - wx) + byteAt(image, x1, y0, channel) * wx
    const bottom = byteAt(image, x0, y1, channel) * (1 - wx) + byteAt(image, x1, y1, channel) * wx
    result[channel] = (top * (1 - wy) + bottom * wy) / 255
  }
  return result as [number, number, number, number]
}

function sampleFaceColor(
  uvs: readonly [Vec2, Vec2, Vec2],
  image: DecodedTextureImage,
  wrapU: TextureWrapMode,
  wrapV: TextureWrapMode,
  flipV: boolean
): [number, number, number, number] {
  const result = [0, 0, 0, 1]
  for (const [a, b, c, weight] of GAUSS_BARYCENTRIC) {
    const color = sampleTexturePixel(
      image,
      a * uvs[0][0] + b * uvs[1][0] + c * uvs[2][0],
      a * uvs[0][1] + b * uvs[1][1] + c * uvs[2][1],
      wrapU,
      wrapV,
      flipV
    )
    // Source textures become opaque filament paint. BambuStudio's conversion samples RGB only,
    // so image transparency must not turn otherwise valid colour into an unpainted face.
    for (let channel = 0; channel < 3; channel += 1) {
      result[channel] = (result[channel] ?? 0) + color[channel]! * weight
    }
  }
  return result as [number, number, number, number]
}

function wrapTextureCoordinate(value: number, mode: TextureWrapMode): number {
  if (mode === 'clamp') return Math.max(0, Math.min(1, value))
  if (mode === 'repeat') return value - Math.floor(value)
  const repeated = ((value % 2) + 2) % 2
  return repeated <= 1 ? repeated : 2 - repeated
}

function subdivideTriangle(triangle: TexturedTriangle): TexturedTriangle[] {
  const [a, b, c] = triangle.positions
  const ab = midpoint3(a, b)
  const bc = midpoint3(b, c)
  const ca = midpoint3(c, a)
  if (!triangle.uvs) {
    const colors = triangle.cornerColors
    const colorAb = colors ? midpoint4(colors[0], colors[1]) : undefined
    const colorBc = colors ? midpoint4(colors[1], colors[2]) : undefined
    const colorCa = colors ? midpoint4(colors[2], colors[0]) : undefined
    return [
      { ...triangle, positions: [a, ab, ca], ...(colors ? { cornerColors: [colors[0], colorAb!, colorCa!] as const } : {}) },
      { ...triangle, positions: [ab, b, bc], ...(colors ? { cornerColors: [colorAb!, colors[1], colorBc!] as const } : {}) },
      { ...triangle, positions: [ca, bc, c], ...(colors ? { cornerColors: [colorCa!, colorBc!, colors[2]] as const } : {}) },
      { ...triangle, positions: [ab, bc, ca], ...(colors ? { cornerColors: [colorAb!, colorBc!, colorCa!] as const } : {}) }
    ]
  }
  const [uvA, uvB, uvC] = triangle.uvs
  const uvAb = midpoint2(uvA, uvB)
  const uvBc = midpoint2(uvB, uvC)
  const uvCa = midpoint2(uvC, uvA)
  const colors = triangle.cornerColors
  const colorAb = colors ? midpoint4(colors[0], colors[1]) : undefined
  const colorBc = colors ? midpoint4(colors[1], colors[2]) : undefined
  const colorCa = colors ? midpoint4(colors[2], colors[0]) : undefined
  return [
    { ...triangle, positions: [a, ab, ca], uvs: [uvA, uvAb, uvCa], ...(colors ? { cornerColors: [colors[0], colorAb!, colorCa!] as const } : {}) },
    { ...triangle, positions: [ab, b, bc], uvs: [uvAb, uvB, uvBc], ...(colors ? { cornerColors: [colorAb!, colors[1], colorBc!] as const } : {}) },
    { ...triangle, positions: [ca, bc, c], uvs: [uvCa, uvBc, uvC], ...(colors ? { cornerColors: [colorCa!, colorBc!, colors[2]] as const } : {}) },
    { ...triangle, positions: [ab, bc, ca], uvs: [uvAb, uvBc, uvCa], ...(colors ? { cornerColors: [colorAb!, colorBc!, colorCa!] as const } : {}) }
  ]
}

const midpoint2 = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
const midpoint3 = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
const midpoint4 = (a: Rgba, b: Rgba): Rgba => [
  (a[0] + b[0]) / 2,
  (a[1] + b[1]) / 2,
  (a[2] + b[2]) / 2,
  (a[3] + b[3]) / 2
]
const averageColors = (colors: readonly [Rgba, Rgba, Rgba]): [number, number, number, number] => [
  (colors[0][0] + colors[1][0] + colors[2][0]) / 3,
  (colors[0][1] + colors[1][1] + colors[2][1]) / 3,
  (colors[0][2] + colors[1][2] + colors[2][2]) / 3,
  (colors[0][3] + colors[1][3] + colors[2][3]) / 3
]
const byteAt = (image: DecodedTextureImage, x: number, y: number, channel: number): number =>
  image.rgba[(y * image.width + x) * 4 + channel] ?? 0
