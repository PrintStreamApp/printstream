/**
 * Source-colour quantization and conversion into Bambu's triangle colour-paint trees.
 *
 * Import parsers retain RGBA in triangle-corner order. This module turns those pixels/vertex
 * colours into a small deterministic palette, then authors the same `paint_color` codes the editor
 * brush uses. Undefined/transparent corners inherit the object's base filament. Clustering works
 * on an 8-bit weighted histogram rather than every corner independently, keeping a million-face
 * model from multiplying the k-means workload by repeated colours.
 */
import type { ImportedMesh } from './imported-mesh.js'
import { encodePaintTree, type PaintTreeNode } from './triangle-paint-codec.js'

export interface SourceColorCluster {
  /** Normalized source RGB after optional Bambu-compatible gamma correction. */
  color: [number, number, number]
  /** Number of opaque triangle corners assigned to this cluster. */
  count: number
}

export interface QuantizedSourceColors {
  clusters: SourceColorCluster[]
  /** Cluster index per triangle corner; -1 means transparent or undefined. */
  labels: number[]
}

/**
 * Remove small islands from texture cluster labels using face adjacency.
 *
 * Level 0 preserves the quantizer exactly. Levels 1..10 allow up to two topology passes per level,
 * reaching BambuStudio's 20-pass ceiling at 10. A face changes only when more adjacent faces carry
 * one different label than retain its current label, so stable borders and disconnected components
 * do not drift. This intentionally changes labels, not geometry: PrintStream's paint tree can place
 * sub-triangle boundaries, while moving model vertices during colour import would change the part.
 */
export function smoothQuantizedTextureColors(
  mesh: Pick<ImportedMesh, 'indices'>,
  quantized: QuantizedSourceColors,
  level: number
): QuantizedSourceColors {
  if (!Number.isInteger(level) || level < 0 || level > 10) throw new Error('Texture smoothing must be between 0 and 10')
  if (quantized.labels.length !== mesh.indices.length) throw new Error('Source colour labels do not match the mesh')
  if (level === 0 || mesh.indices.length < 6) return quantized

  const faceLabels = labelsPerWholeFace(quantized.labels)
  if (!faceLabels) return quantized
  const neighbours = adjacentFaces(mesh.indices)
  for (let pass = 0; pass < level * 2; pass += 1) {
    const previous = [...faceLabels]
    let changed = false
    for (let face = 0; face < previous.length; face += 1) {
      const current = previous[face]!
      if (current < 0) continue
      const counts = new Map<number, number>()
      for (const neighbour of neighbours[face] ?? []) {
        const label = previous[neighbour]!
        if (label >= 0) counts.set(label, (counts.get(label) ?? 0) + 1)
      }
      const sameCount = counts.get(current) ?? 0
      const replacement = [...counts.entries()]
        .filter(([label, count]) => label !== current && count > sameCount)
        .sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0]
      if (replacement == null) continue
      faceLabels[face] = replacement
      changed = true
    }
    if (!changed) break
  }

  const labels = faceLabels.flatMap((label) => [label, label, label])
  const counts = new Array<number>(quantized.clusters.length).fill(0)
  for (const label of labels) if (label >= 0) counts[label] = (counts[label] ?? 0) + 1
  const used = counts.flatMap((count, index) => count > 0 ? [index] : [])
  const remap = new Map(used.map((cluster, index) => [cluster, index]))
  return {
    clusters: used.map((index) => ({ ...quantized.clusters[index]!, count: counts[index]! })),
    labels: labels.map((label) => label < 0 ? -1 : remap.get(label) ?? -1)
  }
}

interface HistogramColor {
  rgb: [number, number, number]
  count: number
  corners: number[]
}

function labelsPerWholeFace(labels: readonly number[]): number[] | null {
  const faces: number[] = []
  for (let offset = 0; offset < labels.length; offset += 3) {
    const first = labels[offset]!
    if (labels[offset + 1] !== first || labels[offset + 2] !== first) return null
    faces.push(first)
  }
  return faces
}

function adjacentFaces(indices: readonly number[]): Array<Set<number>> {
  const neighbours = Array.from({ length: indices.length / 3 }, () => new Set<number>())
  const edgeOwners = new Map<string, number[]>()
  for (let offset = 0; offset < indices.length; offset += 3) {
    const face = offset / 3
    const vertices = [indices[offset]!, indices[offset + 1]!, indices[offset + 2]!]
    for (let edge = 0; edge < 3; edge += 1) {
      const left = vertices[edge]!
      const right = vertices[(edge + 1) % 3]!
      const key = left < right ? `${left}:${right}` : `${right}:${left}`
      const owners = edgeOwners.get(key) ?? []
      for (const owner of owners) {
        neighbours[face]!.add(owner)
        neighbours[owner]!.add(face)
      }
      owners.push(face)
      edgeOwners.set(key, owners)
    }
  }
  return neighbours
}

/**
 * Cluster a triangle-corner RGBA sidecar into 1..32 deterministic source colours.
 *
 * Alpha values at or below BambuStudio's 10/255 threshold remain undefined. Gamma correction is
 * optional and defaults off, matching `gamma_correct_in_import_obj`.
 */
export function quantizeTriangleCornerColors(
  rgba: ArrayLike<number>,
  requestedColors: number,
  options: { gammaCorrect?: boolean } = {}
): QuantizedSourceColors {
  if (rgba.length % 4 !== 0) throw new Error('Triangle-corner colours must contain RGBA values')
  if (!Number.isInteger(requestedColors) || requestedColors < 1 || requestedColors > 32) {
    throw new Error('Source colour count must be between 1 and 32')
  }

  const labels = new Array<number>(rgba.length / 4).fill(-1)
  const histogram = new Map<string, HistogramColor>()
  for (let corner = 0; corner < labels.length; corner += 1) {
    const offset = corner * 4
    if (clamp01(rgba[offset + 3] ?? 0) <= 10 / 255) continue
    const rgb = [rgba[offset] ?? 0, rgba[offset + 1] ?? 0, rgba[offset + 2] ?? 0]
      .map((value) => toByte(options.gammaCorrect ? Math.pow(clamp01(value), 1 / 2.2) : value)) as [number, number, number]
    const key = rgb.join(',')
    const entry = histogram.get(key)
    if (entry) {
      entry.count += 1
      entry.corners.push(corner)
    } else {
      histogram.set(key, { rgb, count: 1, corners: [corner] })
    }
  }
  const colors = [...histogram.values()]
  if (colors.length === 0) return { clusters: [], labels }

  const count = Math.min(requestedColors, colors.length)
  let centers = initialCenters(colors, count)
  let assignments = new Array<number>(colors.length).fill(0)
  for (let iteration = 0; iteration < 100; iteration += 1) {
    assignments = colors.map((color) => nearestCenter(color.rgb, centers))
    const next = recomputeCenters(colors, assignments, centers)
    const movement = next.reduce((total, center, index) => total + colorDistance(center, centers[index]!), 0)
    centers = next
    if (movement < 0.25) break
  }

  const counts = new Array<number>(centers.length).fill(0)
  assignments.forEach((cluster, index) => { counts[cluster] = (counts[cluster] ?? 0) + colors[index]!.count })
  const order = centers.map((center, index) => ({ center, count: counts[index] ?? 0, index }))
    .sort((left, right) => right.count - left.count
      || left.center[0] - right.center[0]
      || left.center[1] - right.center[1]
      || left.center[2] - right.center[2])
  const remap = new Map(order.map((entry, index) => [entry.index, index]))
  colors.forEach((color, index) => {
    const cluster = remap.get(assignments[index]!)!
    for (const corner of color.corners) labels[corner] = cluster
  })
  return {
    clusters: order.map((entry) => ({
      color: entry.center.map((channel) => channel / 255) as [number, number, number],
      count: entry.count
    })),
    labels
  }
}

/**
 * Author `paint_color` codes from quantized corner labels and a cluster-to-filament mapping.
 * Triangles wholly using the base filament are omitted; mixed triangles use BambuStudio's exact
 * one-split/two-split tree shapes, including its largest-angle choice for three distinct corners.
 */
export function buildImportedColorPaint(
  mesh: Pick<ImportedMesh, 'positions' | 'indices'>,
  cornerLabels: readonly number[],
  clusterFilamentIds: readonly number[],
  baseFilamentId: number
): Record<number, string> {
  if (cornerLabels.length !== mesh.indices.length) throw new Error('Source colour labels do not match the mesh')
  assertFilamentId(baseFilamentId)
  for (const id of clusterFilamentIds) assertFilamentId(id)
  const triangles: Record<number, string> = {}
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const states = [0, 1, 2].map((corner) => {
      const label = cornerLabels[offset + corner] ?? -1
      return label < 0 ? baseFilamentId : clusterFilamentIds[label] ?? baseFilamentId
    }) as [number, number, number]
    if (states.every((state) => state === baseFilamentId)) continue
    triangles[offset / 3] = encodePaintTree(paintTreeForTriangle(mesh, offset, states))
  }
  return triangles
}

function initialCenters(colors: readonly HistogramColor[], count: number): Array<[number, number, number]> {
  const ranked = [...colors].sort((left, right) => right.count - left.count || compareRgb(left.rgb, right.rgb))
  const centers: Array<[number, number, number]> = [[...ranked[0]!.rgb]]
  while (centers.length < count) {
    const next = ranked.reduce((best, color) => {
      const score = Math.min(...centers.map((center) => colorDistance(color.rgb, center))) * color.count
      return score > best.score ? { color, score } : best
    }, { color: ranked[0]!, score: -1 })
    centers.push([...next.color.rgb])
  }
  return centers
}

function recomputeCenters(
  colors: readonly HistogramColor[],
  assignments: readonly number[],
  previous: readonly [number, number, number][]
): Array<[number, number, number]> {
  return previous.map((fallback, cluster) => {
    const sum = [0, 0, 0]
    let weight = 0
    colors.forEach((color, index) => {
      if (assignments[index] !== cluster) return
      weight += color.count
      for (let channel = 0; channel < 3; channel += 1) {
        sum[channel] = (sum[channel] ?? 0) + color.rgb[channel]! * color.count
      }
    })
    return weight === 0 ? [...fallback] : sum.map((channel) => Math.round(channel / weight)) as [number, number, number]
  })
}

function nearestCenter(rgb: readonly number[], centers: readonly [number, number, number][]): number {
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  centers.forEach((center, index) => {
    const distance = colorDistance(rgb, center)
    if (distance < bestDistance) {
      best = index
      bestDistance = distance
    }
  })
  return best
}

function paintTreeForTriangle(
  mesh: Pick<ImportedMesh, 'positions' | 'indices'>,
  offset: number,
  states: [number, number, number]
): PaintTreeNode {
  if (states[0] === states[1] && states[1] === states[2]) return { kind: 'leaf', state: states[0] }
  const unique = new Set(states)
  if (unique.size === 2) {
    const isolated = states[0] !== states[1] && states[0] !== states[2] ? 0 : states[1] !== states[2] ? 1 : 2
    return { kind: 'split', splits: 2, special: isolated, children: states.map(leaf) }
  }
  const largest = largestTriangleAngleVertex(mesh, offset)
  const pairs = largest === 0
    ? { special: 1 as const, states: [states[1], states[2]] }
    : largest === 1
      ? { special: 2 as const, states: [states[0], states[2]] }
      : { special: 0 as const, states: [states[1], states[0]] }
  return {
    kind: 'split',
    splits: 3,
    special: 0,
    children: [...states.map(leaf), {
      kind: 'split', splits: 1, special: pairs.special, children: pairs.states.map(leaf)
    }]
  }
}

function largestTriangleAngleVertex(mesh: Pick<ImportedMesh, 'positions' | 'indices'>, offset: number): 0 | 1 | 2 {
  const points = [0, 1, 2].map((corner) => {
    const vertex = (mesh.indices[offset + corner] ?? 0) * 3
    return [mesh.positions[vertex] ?? 0, mesh.positions[vertex + 1] ?? 0, mesh.positions[vertex + 2] ?? 0]
  })
  const angles = points.map((point, index) => {
    const left = subtract(points[(index + 1) % 3]!, point)
    const right = subtract(points[(index + 2) % 3]!, point)
    const divisor = Math.hypot(...left) * Math.hypot(...right)
    return divisor === 0 ? 0 : Math.acos(Math.max(-1, Math.min(1, dot(left, right) / divisor)))
  })
  return (angles[1]! > angles[0]! ? (angles[2]! > angles[1]! ? 2 : 1) : angles[2]! > angles[0]! ? 2 : 0)
}

const leaf = (state: number): PaintTreeNode => ({ kind: 'leaf', state })
const subtract = (a: readonly number[], b: readonly number[]): number[] => a.map((value, index) => value - (b[index] ?? 0))
const dot = (a: readonly number[], b: readonly number[]): number => a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0)
const colorDistance = (a: readonly number[], b: readonly number[]): number => a.reduce((sum, value, index) => sum + (value - (b[index] ?? 0)) ** 2, 0)
const compareRgb = (a: readonly number[], b: readonly number[]): number => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))
const toByte = (value: number): number => Math.round(clamp01(value) * 255)

function assertFilamentId(id: number): void {
  if (!Number.isInteger(id) || id < 1 || id > 255) throw new Error('Filament ids must be between 1 and 255')
}
