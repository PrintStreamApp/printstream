/** Builds renderer-ready, non-indexed geometry for the source-colour comparison preview. */
import type { ImportedMesh, QuantizedSourceColors } from '@printstream/shared/three-mf'

const FALLBACK_COLOR = 0.55

export interface SourceColorPreviewGeometry {
  positions: Float32Array
  originalColors: Float32Array
}

/**
 * Expand indexed import geometry into triangle-corner order, matching the retained RGBA sidecar.
 * Transparent source corners use neutral grey because they inherit the object's base filament.
 */
export function buildSourceColorPreviewGeometry(
  mesh: Pick<ImportedMesh, 'positions' | 'indices'>,
  sourceColors: ArrayLike<number>
): SourceColorPreviewGeometry {
  if (mesh.indices.length * 4 !== sourceColors.length) {
    throw new Error('Source colours do not match the preview mesh')
  }

  const positions = new Float32Array(mesh.indices.length * 3)
  const originalColors = new Float32Array(mesh.indices.length * 3)
  for (let corner = 0; corner < mesh.indices.length; corner += 1) {
    const vertex = mesh.indices[corner]!
    const sourceOffset = vertex * 3
    if (vertex < 0 || sourceOffset + 2 >= mesh.positions.length) {
      throw new Error('Preview mesh contains an invalid vertex index')
    }

    const outputOffset = corner * 3
    for (let channel = 0; channel < 3; channel += 1) {
      const coordinate = mesh.positions[sourceOffset + channel]
      if (!Number.isFinite(coordinate)) throw new Error('Preview mesh contains a non-finite coordinate')
      positions[outputOffset + channel] = coordinate!
    }

    const colorOffset = corner * 4
    const visible = clamp01(sourceColors[colorOffset + 3] ?? 0) > 10 / 255
    for (let channel = 0; channel < 3; channel += 1) {
      originalColors[outputOffset + channel] = visible
        ? clamp01(sourceColors[colorOffset + channel] ?? 0)
        : FALLBACK_COLOR
    }
  }
  return { positions, originalColors }
}

/** Convert quantized corner labels into the RGB attribute used by the Multi-Color preview. */
export function buildQuantizedPreviewColors(
  cornerCount: number,
  quantized: QuantizedSourceColors
): Float32Array {
  if (quantized.labels.length !== cornerCount) throw new Error('Quantized colours do not match the preview mesh')

  const colors = new Float32Array(cornerCount * 3)
  for (let corner = 0; corner < cornerCount; corner += 1) {
    const cluster = quantized.clusters[quantized.labels[corner] ?? -1]
    for (let channel = 0; channel < 3; channel += 1) {
      colors[corner * 3 + channel] = cluster ? clamp01(cluster.color[channel] ?? 0) : FALLBACK_COLOR
    }
  }
  return colors
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}
