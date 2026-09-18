/**
 * Web adapter over the canonical filament identity resolution in
 * `@printstream/shared` (filament-identity.ts / bambu-colors.ts /
 * bambu-filament-presets.ts). The resolvers, the genuine-Bambu gate, and the
 * Bambu catalogues all live in shared so the API resolves identically; this
 * module re-exports them for existing web imports and keeps only the
 * web-specific presentation helpers (CSS backgrounds, compact labels, swatch
 * pickers, perceptual colour distance for "nearest match" ranking).
 */
import {
  COMMON_FILAMENT_COLOR_SWATCHES,
  bambuColorsForMaterial,
  commonFilamentColorName,
  normalizeFilamentPalette,
  type FilamentColorSwatchOption
} from '@printstream/shared'

// Canonical resolution lives in @printstream/shared: re-exported here for existing consumers.
export {
  COMMON_FILAMENT_COLOR_SWATCHES,
  commonFilamentColorName,
  filamentColorLabel,
  filamentIdentityLabel,
  hasBambuRfidTag,
  isGenuineBambuTray,
  isRawTrayCode,
  resolveFilamentColorName,
  resolveFilamentDisplay,
  resolveFilamentIdentity,
  resolveFilamentSwatchName,
  resolveProjectFilamentColorName,
  type FilamentColorInput,
  type ResolvedFilamentDisplay,
  type ResolvedFilamentIdentity
} from '@printstream/shared'
export type { FilamentColorSwatchOption }

/**
 * Curated set of filament material types for constrained pickers (e.g. the queue's one-off custom
 * material), so a type is chosen from a known list rather than typed free-form. Callers should still
 * fold in the current value when it falls outside this list (a sliced preset such as "PLA Basic").
 */
export const COMMON_FILAMENT_TYPES = [
  'PLA',
  'PETG',
  'ABS',
  'ASA',
  'TPU',
  'PC',
  'PA',
  'PVA',
  'HIPS',
  'PLA-CF',
  'PETG-CF',
  'PA-CF',
  'PA6-CF',
  'PC-CF',
  'PET-CF'
] as const

/**
 * Replace any `#RRGGBB` hex codes embedded in a human-facing string with a friendly
 * common colour name, leaving unrecognized colours (and the rest of the text) as-is.
 * For pre-built messages from the shared matcher (e.g. "Needs PLA #FFFFFF") that have no
 * material context to do a richer Bambu-swatch lookup.
 */
export function humanizeFilamentColorsInText(text: string): string {
  return text.replace(/#[0-9a-fA-F]{6}\b/g, (hex) => commonFilamentColorName(hex) ?? hex)
}

export { colorDistance, deltaE2000, type Lab } from './colorDistance'

export function resolveFilamentColorSwatches(
  material: string | null | undefined,
  options: { presetBrand?: string | null } = {}
): {
  swatches: FilamentColorSwatchOption[]
  usesCommonFallback: boolean
} {
  if (options.presetBrand && options.presetBrand !== 'Bambu') {
    return { swatches: COMMON_FILAMENT_COLOR_SWATCHES, usesCommonFallback: true }
  }

  const swatches = bambuColorsForMaterial(material ?? null)
  if (swatches.length > 0) {
    return { swatches, usesCommonFallback: false }
  }

  return { swatches: COMMON_FILAMENT_COLOR_SWATCHES, usesCommonFallback: true }
}

/**
 * What a slot tile says when it holds filament nobody could name.
 *
 * A WORD, not a `?`: the glyph reads as a question rather than a state, and a screen reader
 * announces "A3 question mark". This is a real condition, not a missing value: the tray is loaded
 * (`hasLoadedFilament`) but no preset, type or material resolved, which is why the tile draws it in
 * the warning colour rather than the filament's. Shared so the tile agrees with the tooltip and the
 * edit dialog behind it, which say "Unknown filament" for the same slot.
 */
export const UNKNOWN_FILAMENT_TYPE_LABEL = 'Unknown'

/**
 * What a slot tile says when nothing is loaded at all.
 *
 * Paired with {@link UNKNOWN_FILAMENT_TYPE_LABEL} because the two are easy to conflate and mean
 * opposite things to someone deciding whether they can print: EMPTY is a tray to put a spool in,
 * UNKNOWN is a tray with a spool whose material did not resolve. Shared so the AMS slot and the
 * external spool, which render the same state from different data, cannot drift apart -- they did,
 * and the empty external spool claimed "Unknown".
 */
export const EMPTY_FILAMENT_SLOT_LABEL = 'Empty'

export function resolveCompactFilamentTypeLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) return null

  const normalized = trimmed.toUpperCase()
  if (normalized === 'PLA-S' || normalized.includes('SUPPORT FOR PLA/PETG') || normalized.includes('SUPPORT FOR PLA')) return 'Sup. PLA'
  if (normalized.includes('SUPPORT FOR ABS')) return 'Sup. ABS'
  if (normalized.includes('SUPPORT FOR PA/PET')) return 'Sup. PA/PET'
  if (normalized.includes('SUPPORT')) return 'SUPPORT'

  for (const type of COMPACT_FILAMENT_TYPE_ORDER) {
    if (normalized.includes(type)) return type
  }

  return trimmed
}

export function hasLoadedFilament(
  filamentType: string | null | undefined,
  color: string | null | undefined,
  colors?: readonly string[] | null | undefined,
  options: { trayInfoIdx?: string | null; trayName?: string | null; trayUuid?: string | null; occupied?: boolean | null | undefined; remainPercent?: number | null | undefined } = {}
): boolean {
  return Boolean(
    (filamentType?.trim() ?? '')
    || normalizeFilamentPalette(colors, color).length > 0
    || (options.trayInfoIdx?.trim() ?? '')
    || (options.trayName?.trim() ?? '')
    || (options.trayUuid?.trim() ?? '')
    || options.occupied === true
    || options.remainPercent != null
  )
}

export function filamentBackground(
  colors: readonly string[] | null | undefined,
  fallbackColor: string | null | undefined,
  emptyColor = 'var(--joy-palette-neutral-800)'
): string {
  const palette = normalizeFilamentPalette(colors, fallbackColor)
  if (palette.length === 0) return emptyColor
  if (palette.length === 1) return palette[0] ?? emptyColor

  const step = 100 / palette.length
  const stops = palette.flatMap((color, index) => {
    const start = `${(index * step).toFixed(2)}%`
    const end = `${((index + 1) * step).toFixed(2)}%`
    return [`${color} ${start}`, `${color} ${end}`]
  })
  return `linear-gradient(135deg, ${stops.join(', ')})`
}

export function filamentTextColor(
  colors: readonly string[] | null | undefined,
  fallbackColor: string | null | undefined,
  emptyColor = 'var(--joy-palette-text-primary)'
): string {
  const palette = normalizeFilamentPalette(colors, fallbackColor)
  if (palette.length === 0) return emptyColor

  const rgb = palette.reduce(
    (accumulator, color) => {
      accumulator.r += parseInt(color.slice(1, 3), 16)
      accumulator.g += parseInt(color.slice(3, 5), 16)
      accumulator.b += parseInt(color.slice(5, 7), 16)
      return accumulator
    },
    { r: 0, g: 0, b: 0 }
  )

  const count = palette.length
  const luminance = (0.299 * (rgb.r / count) + 0.587 * (rgb.g / count) + 0.114 * (rgb.b / count)) / 255
  return luminance > 0.6 ? '#1a1a1a' : '#fff'
}

const COMPACT_FILAMENT_TYPE_ORDER = [
  'PAHT-CF',
  'PA12-CF',
  'PA612-CF',
  'PETG-ESD',
  'PETG-CF',
  'PLA-CF',
  'ABS-GF',
  'ASA-CF',
  'PA6-CF',
  'PA6-GF',
  'PPA-CF',
  'PPA-GF',
  'PET-CF',
  'PPS-CF',
  'PCTG',
  'PETG',
  'PLA',
  'ABS',
  'ASA',
  'TPU',
  'PVA',
  'BVOH',
  'HIPS',
  'PPS',
  'PC',
  'PPA',
  'PA',
  'PP',
  'PE',
  'PHA',
  'EVA'
] as const
