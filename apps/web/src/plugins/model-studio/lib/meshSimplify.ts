/**
 * Paint-preserving mesh simplification shared by the preview worker and its main-thread fallback.
 *
 * Geometry is welded by exact position only. Paint is remapped after simplification: making paint
 * part of vertex identity disconnects shared edges and prevents painted models from simplifying.
 */
import type { TrianglePaintChannel } from './threeMfScene'
import { analyzeSoupTopology } from './meshTopology'

export const SIMPLIFY_DETAIL_LEVELS = [
  { value: 'extraHigh', label: 'Extra high', maxError: 1e-3 },
  { value: 'high', label: 'High', maxError: 1e-2 },
  { value: 'medium', label: 'Medium', maxError: 0.1 },
  { value: 'low', label: 'Low', maxError: 0.5 },
  { value: 'extraLow', label: 'Extra low', maxError: 1 }
] as const

export type SimplifyDetailLevel = typeof SIMPLIFY_DETAIL_LEVELS[number]['value']
export type SimplifyMode = 'detail' | 'ratio'
export type SimplifyPaint = Partial<Record<TrianglePaintChannel, Record<number, string>>>

export interface SimplifySettings {
  mode: SimplifyMode
  detail: SimplifyDetailLevel
  /** Percentage of source triangles to remove, matching BambuStudio's decimate ratio. */
  ratio: number
}

export interface SimplifyResult {
  soup: Float32Array
  paint: SimplifyPaint
  triangleCount: number
  error: number
}

interface IndexedPaintMesh {
  positions: Float32Array
  indices: Uint32Array
  sourceSoup: Float32Array
  sourcePaint: SimplifyPaint
  incidentOffsets: Uint32Array
  incidentTriangles: Uint32Array
}

const CHANNELS: readonly TrianglePaintChannel[] = ['supports', 'seam', 'color', 'fuzzy']
const MIN_PRINTABLE_TRIANGLES = 4

/** Whether a soup has no boundary edge, without pulling the boolean engine into this worker. */
function isClosedSoup(soup: Float32Array): boolean {
  const topology = analyzeSoupTopology(soup)
  if (!topology) return false
  for (const count of topology.edgeUses.values()) if (count < 2) return false
  return true
}

/** Convert a reduction percentage to a safe triangle target with BambuStudio reduction semantics. */
export function simplifyTargetTriangleCount(triangleCount: number, ratio: number): number {
  if (triangleCount <= 0) return 0
  const clamped = Math.min(100, Math.max(0, ratio))
  const requested = Math.round(triangleCount * (100 - clamped) / 100)
  return Math.min(triangleCount, Math.max(MIN_PRINTABLE_TRIANGLES, requested))
}

/** Index one connected topology and build compact source adjacency for later paint remapping. */
export function indexPaintedTriangleSoup(soup: Float32Array, paint: SimplifyPaint): IndexedPaintMesh {
  if (soup.length % 9 !== 0) throw new Error('The selected volume has invalid triangle data.')
  const positions: number[] = []
  const indices = new Uint32Array(soup.length / 3)
  const vertexIds = new Map<string, number>()

  for (let corner = 0; corner < soup.length / 3; corner += 1) {
    const offset = corner * 3
    const x = soup[offset]!
    const y = soup[offset + 1]!
    const z = soup[offset + 2]!
    const key = `${Object.is(x, -0) ? 0 : x},${Object.is(y, -0) ? 0 : y},${Object.is(z, -0) ? 0 : z}`
    let vertex = vertexIds.get(key)
    if (vertex === undefined) {
      vertex = positions.length / 3
      positions.push(x, y, z)
      vertexIds.set(key, vertex)
    }
    indices[corner] = vertex
  }

  const counts = new Uint32Array(positions.length / 3)
  for (const vertex of indices) counts[vertex] = (counts[vertex] ?? 0) + 1
  const incidentOffsets = new Uint32Array(counts.length + 1)
  for (let vertex = 0; vertex < counts.length; vertex += 1) {
    incidentOffsets[vertex + 1] = (incidentOffsets[vertex] ?? 0) + (counts[vertex] ?? 0)
  }
  const cursors = incidentOffsets.slice(0, counts.length)
  const incidentTriangles = new Uint32Array(indices.length)
  for (let corner = 0; corner < indices.length; corner += 1) {
    const vertex = indices[corner]!
    incidentTriangles[cursors[vertex]!] = Math.floor(corner / 3)
    cursors[vertex] = cursors[vertex]! + 1
  }

  return {
    positions: new Float32Array(positions),
    indices,
    sourceSoup: soup,
    sourcePaint: paint,
    incidentOffsets,
    incidentTriangles
  }
}

/** Pick the nearest source facet incident to any output vertex, preferring shared edges. */
function sourceTriangleFor(mesh: IndexedPaintMesh, a: number, b: number, c: number): number {
  const outputX = ((mesh.positions[a * 3] ?? 0) + (mesh.positions[b * 3] ?? 0) + (mesh.positions[c * 3] ?? 0)) / 3
  const outputY = ((mesh.positions[a * 3 + 1] ?? 0) + (mesh.positions[b * 3 + 1] ?? 0) + (mesh.positions[c * 3 + 1] ?? 0)) / 3
  const outputZ = ((mesh.positions[a * 3 + 2] ?? 0) + (mesh.positions[b * 3 + 2] ?? 0) + (mesh.positions[c * 3 + 2] ?? 0)) / 3
  let bestTriangle = 0
  let bestShared = -1
  let bestDistance = Number.POSITIVE_INFINITY

  for (const vertex of [a, b, c]) {
    const start = mesh.incidentOffsets[vertex] ?? 0
    const end = mesh.incidentOffsets[vertex + 1] ?? start
    for (let offset = start; offset < end; offset += 1) {
      const triangle = mesh.incidentTriangles[offset] ?? 0
      const sourceA = mesh.indices[triangle * 3]!
      const sourceB = mesh.indices[triangle * 3 + 1]!
      const sourceC = mesh.indices[triangle * 3 + 2]!
      const shared = Number(sourceA === a || sourceA === b || sourceA === c)
        + Number(sourceB === a || sourceB === b || sourceB === c)
        + Number(sourceC === a || sourceC === b || sourceC === c)
      const sourceOffset = triangle * 9
      const dx = ((mesh.sourceSoup[sourceOffset] ?? 0) + (mesh.sourceSoup[sourceOffset + 3] ?? 0)
        + (mesh.sourceSoup[sourceOffset + 6] ?? 0)) / 3 - outputX
      const dy = ((mesh.sourceSoup[sourceOffset + 1] ?? 0) + (mesh.sourceSoup[sourceOffset + 4] ?? 0)
        + (mesh.sourceSoup[sourceOffset + 7] ?? 0)) / 3 - outputY
      const dz = ((mesh.sourceSoup[sourceOffset + 2] ?? 0) + (mesh.sourceSoup[sourceOffset + 5] ?? 0)
        + (mesh.sourceSoup[sourceOffset + 8] ?? 0)) / 3 - outputZ
      const distance = dx * dx + dy * dy + dz * dz
      if (shared > bestShared || (shared === bestShared && distance < bestDistance)) {
        bestTriangle = triangle
        bestShared = shared
        bestDistance = distance
      }
    }
  }
  return bestTriangle
}

/** Rebuild non-indexed geometry and remap all four paint channels from source facets. */
export function expandSimplifiedMesh(mesh: IndexedPaintMesh, indices: Uint32Array, error: number): SimplifyResult {
  const soup = new Float32Array(indices.length * 3)
  const paint: SimplifyPaint = {}

  for (let triangle = 0; triangle < indices.length / 3; triangle += 1) {
    const a = indices[triangle * 3]!
    const b = indices[triangle * 3 + 1]!
    const c = indices[triangle * 3 + 2]!
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = indices[triangle * 3 + corner]!
      soup.set(mesh.positions.subarray(vertex * 3, vertex * 3 + 3), triangle * 9 + corner * 3)
    }
    const sourceTriangle = sourceTriangleFor(mesh, a, b, c)
    for (const channel of CHANNELS) {
      const code = mesh.sourcePaint[channel]?.[sourceTriangle]
      if (!code) continue
      const channelPaint = paint[channel] ?? {}
      channelPaint[triangle] = code
      paint[channel] = channelPaint
    }
  }

  return { soup, paint, triangleCount: indices.length / 3, error }
}

/** Run meshoptimizer's quadric simplifier with BambuStudio-compatible controls. */
export async function simplifyTriangleSoup(
  soup: Float32Array,
  paint: SimplifyPaint,
  settings: SimplifySettings
): Promise<SimplifyResult> {
  const { MeshoptSimplifier } = await import('meshoptimizer/simplifier')
  await MeshoptSimplifier.ready
  if (!MeshoptSimplifier.supported) throw new Error('Mesh simplification is not supported in this browser.')

  const mesh = indexPaintedTriangleSoup(soup, paint)
  const sourceTriangles = mesh.indices.length / 3
  if (sourceTriangles <= MIN_PRINTABLE_TRIANGLES) return expandSimplifiedMesh(mesh, mesh.indices, 0)

  const detail = SIMPLIFY_DETAIL_LEVELS.find((entry) => entry.value === settings.detail)
    ?? SIMPLIFY_DETAIL_LEVELS[2]
  const targetTriangles = settings.mode === 'ratio'
    ? simplifyTargetTriangleCount(sourceTriangles, settings.ratio)
    : MIN_PRINTABLE_TRIANGLES
  const maxError = settings.mode === 'ratio' ? Number.MAX_VALUE : detail.maxError
  const [indices, error] = MeshoptSimplifier.simplify(
    mesh.indices,
    mesh.positions,
    3,
    targetTriangles * 3,
    maxError,
    ['ErrorAbsolute']
  )
  const result = expandSimplifiedMesh(mesh, indices, error)
  if (result.triangleCount < MIN_PRINTABLE_TRIANGLES || (isClosedSoup(soup) && !isClosedSoup(result.soup))) {
    return expandSimplifiedMesh(mesh, mesh.indices, 0)
  }
  return result
}
