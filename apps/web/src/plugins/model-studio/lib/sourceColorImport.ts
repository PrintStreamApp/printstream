/** Pure palette helpers for the OBJ source-colour mapping dialog and its commit boundary. */
import type { StagedImportFormat } from '@printstream/shared'
import type { QuantizedSourceColors } from '@printstream/shared/three-mf'
import type { FilamentOption } from '../../../components/library/PlateGcodeSections'

export const APPEND_SOURCE_COLOR = 'append' as const
export const OBJ_IMPORT_GAMMA_PREFERENCE_KEY = 'printstream.modelStudio.objImportGammaCorrection'
export type SourceColorMapping = number | typeof APPEND_SOURCE_COLOR
export type SourceColorMode = 'vertex' | 'material' | 'texture'

export interface SourceColorImportChoice {
  quantized: QuantizedSourceColors
  mappings: SourceColorMapping[]
}

/** Whether a staged import retained source appearance that needs filament mapping. */
export function shouldMapSourceColors(sourceColorMode: SourceColorMode | undefined): sourceColorMode is SourceColorMode {
  return sourceColorMode != null
}

/** Gamma correction mirrors the OBJ colour dialog and must not alter decoded texture pixels. */
export function supportsSourceColorGamma(format: StagedImportFormat, sourceColorMode: SourceColorMode): boolean {
  return format === 'obj' && sourceColorMode !== 'texture'
}

/** A stale or hand-edited preference may only restore an actual boolean. */
export function sanitizeObjImportGammaPreference(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false
}

/** Recommend a practical four-colour start, bounded by actual opaque source colours. */
export function recommendedSourceColorCount(sourceColors: ArrayLike<number>): number {
  const seen = new Set<string>()
  for (let offset = 0; offset + 3 < sourceColors.length && seen.size < 4; offset += 4) {
    if (Math.max(0, Math.min(1, sourceColors[offset + 3] ?? 0)) <= 10 / 255) continue
    seen.add([0, 1, 2].map((channel) => Math.round(
      Math.max(0, Math.min(1, sourceColors[offset + channel] ?? 0)) * 255
    )).join(','))
  }
  return Math.max(1, seen.size)
}

/** Assign each cluster to the closest current filament swatch in sRGB space. */
export function matchSourceColorsToFilaments(
  quantized: QuantizedSourceColors,
  filaments: readonly FilamentOption[]
): number[] {
  const candidates = filaments.flatMap((filament) => {
    const rgb = parseHexColor(filament.color)
    return rgb ? [{ id: filament.id, rgb }] : []
  })
  const fallback = filaments[0]?.id ?? 1
  return quantized.clusters.map((cluster) => {
    let best = fallback
    let distance = Number.POSITIVE_INFINITY
    for (const candidate of candidates) {
      const next = colorDistance(cluster.color, candidate.rgb)
      if (next < distance) {
        distance = next
        best = candidate.id
      }
    }
    return best
  })
}

/** Convert a normalized source palette colour into the project's CSS/persisted hex form. */
export function sourceColorHex(rgb: readonly number[]): string {
  return `#${rgb.map((value) => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, '0')).join('')}`
}

function parseHexColor(value: string | null | undefined): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(value ?? '')
  if (!match) return null
  const packed = Number.parseInt(match[1]!, 16)
  return [((packed >> 16) & 255) / 255, ((packed >> 8) & 255) / 255, (packed & 255) / 255]
}

function colorDistance(left: readonly number[], right: readonly number[]): number {
  return left.reduce((sum, value, index) => sum + (value - (right[index] ?? 0)) ** 2, 0)
}
