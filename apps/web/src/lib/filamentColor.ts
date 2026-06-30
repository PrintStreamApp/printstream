/**
 * Resolve Bambu filament color labels and palettes for AMS UI.
 *
 * Exact Bambu multi-color matches are resolved from `trayInfoIdx + colors`
 * first, then from single-color swatches, and finally from meaningful tray
 * names. Raw `tray_id_name` shorthand such as `A00-G0` is exposed as metadata
 * (`rawTrayCode`) but should not become the primary human-facing label unless
 * a stronger match exists.
 */
import {
  bambuColorsForMaterial,
  bambuMaterialFromPresetName,
  bambuMaterialFromType,
  bambuSwatchForHex,
  type BambuColorSwatch
} from '../data/bambuColors.js'
import { filamentPresetBrandFromId, filamentPresetNameFromId } from '../data/bambuFilamentPresets.js'
import { findBambuEncodedMultiColor, findBambuEncodedMultiColorAlias } from '../data/bambuEncodedMultiColors.js'

export interface ResolvedFilamentDisplay {
  name: string | null
  material: string | null
  colors: string[]
  rawTrayCode: string | null
}

interface FilamentColorInput {
  color: string | null | undefined
  colors?: readonly string[] | null | undefined
  trayName: string | null | undefined
  trayInfoIdx?: string | null | undefined
  filamentType: string | null | undefined
  trayUuid?: string | null | undefined
}

export type FilamentColorSwatchOption = Pick<BambuColorSwatch, 'name' | 'hex'>

export const COMMON_FILAMENT_COLOR_SWATCHES: FilamentColorSwatchOption[] = [
  { name: 'White', hex: '#FFFFFF' },
  { name: 'Black', hex: '#000000' },
  { name: 'Light Gray', hex: '#D0D3D4' },
  { name: 'Gray', hex: '#8A8F98' },
  { name: 'Silver', hex: '#B7BCC3' },
  { name: 'Natural', hex: '#E6DDCC' },
  { name: 'Beige', hex: '#D9C3A5' },
  { name: 'Brown', hex: '#7A4B2F' },
  { name: 'Red', hex: '#C7372F' },
  { name: 'Orange', hex: '#F47A20' },
  { name: 'Yellow', hex: '#F2D230' },
  { name: 'Green', hex: '#2FA84F' },
  { name: 'Olive', hex: '#6B7A2B' },
  { name: 'Blue', hex: '#1F5FBF' },
  { name: 'Navy', hex: '#1F355E' },
  { name: 'Cyan', hex: '#35C7D9' },
  { name: 'Purple', hex: '#7C4DAD' },
  { name: 'Pink', hex: '#E67AAE' }
]

const COMMON_FILAMENT_COLOR_ALIASES: Record<string, string> = {
  '#00FFFF': 'Cyan'
}

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

export function commonFilamentColorName(hex: string | null | undefined): string | null {
  const normalized = normalizeHexColor(hex)
  if (!normalized) return null
  return COMMON_FILAMENT_COLOR_SWATCHES.find((swatch) => swatch.hex === normalized)?.name
    ?? COMMON_FILAMENT_COLOR_ALIASES[normalized]
    ?? null
}

/**
 * Replace any `#RRGGBB` hex codes embedded in a human-facing string with a friendly
 * common colour name, leaving unrecognized colours (and the rest of the text) as-is.
 * For pre-built messages from the shared matcher (e.g. "Needs PLA #FFFFFF") that have no
 * material context to do a richer Bambu-swatch lookup.
 */
export function humanizeFilamentColorsInText(text: string): string {
  return text.replace(/#[0-9a-fA-F]{6}\b/g, (hex) => commonFilamentColorName(hex) ?? hex)
}

/**
 * Perceptual colour distance (CIEDE2000) between two hex colours, for ranking "nearest match"
 * filaments. 0 = identical; a just-noticeable difference is ~1; opposite colours are ~100. A raw
 * RGB Euclidean distance would judge a *muted* hue close to a grey of similar brightness (a dark
 * teal scores near "dark grey"), so same-hue filaments lose to greys; the perceptual metric weights
 * hue and chroma so a teal ranks nearest other teals/cyans instead. Returns Infinity when either
 * side is unparseable so unknown colours sort last.
 */
export function colorDistance(hexA: string | null | undefined, hexB: string | null | undefined): number {
  const a = hexToRgb(hexA)
  const b = hexToRgb(hexB)
  if (!a || !b) return Number.POSITIVE_INFINITY
  return deltaE2000(rgbToLab(a[0], a[1], a[2]), rgbToLab(b[0], b[1], b[2]))
}

/** A CIELAB colour as `[L*, a*, b*]`. */
export type Lab = readonly [number, number, number]

/** Parse a hex colour (any form {@link normalizeHexColor} accepts) into `[r, g, b]` 0-255, or null. */
function hexToRgb(value: string | null | undefined): [number, number, number] | null {
  const normalized = normalizeHexColor(value)
  if (!normalized) return null
  return [
    parseInt(normalized.slice(1, 3), 16),
    parseInt(normalized.slice(3, 5), 16),
    parseInt(normalized.slice(5, 7), 16)
  ]
}

/** sRGB component (0-255) → linear-light (0-1). */
function srgbToLinear(channel: number): number {
  const v = channel / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

/** Convert an sRGB colour (0-255 channels) to CIELAB under the D65 white point. */
function rgbToLab(r: number, g: number, b: number): Lab {
  const rl = srgbToLinear(r)
  const gl = srgbToLinear(g)
  const bl = srgbToLinear(b)
  // linear sRGB → CIE XYZ (D65 primaries)
  const x = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375
  const y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175
  const z = rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041
  // normalise to the D65 reference white, then apply the CIE f(t) transfer
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116)
  const fx = f(x / 0.95047)
  const fy = f(y / 1)
  const fz = f(z / 1.08883)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

const DEG = Math.PI / 180

/** Hue angle in degrees [0, 360) for the (a', b') chroma components. */
function hueAngle(ap: number, b: number): number {
  if (ap === 0 && b === 0) return 0
  const deg = Math.atan2(b, ap) / DEG
  return deg >= 0 ? deg : deg + 360
}

/**
 * CIEDE2000 colour difference between two CIELAB colours — the current CIE standard for perceptual
 * colour distance. Unlike a raw Euclidean metric it weights lightness, chroma, and hue separately
 * (with a blue-region hue-rotation term), so a saturated colour is not judged close to a grey of
 * similar lightness. 0 = identical; ~1 is a just-noticeable difference. Implementation follows
 * Sharma, Wu & Dalal (2005); verified against their reference data in the unit test.
 */
export function deltaE2000(reference: Lab, sample: Lab): number {
  const [L1, a1, b1] = reference
  const [L2, a2, b2] = sample

  const C1 = Math.hypot(a1, b1)
  const C2 = Math.hypot(a2, b2)
  const Cbar = (C1 + C2) / 2
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)))

  const a1p = (1 + G) * a1
  const a2p = (1 + G) * a2
  const C1p = Math.hypot(a1p, b1)
  const C2p = Math.hypot(a2p, b2)
  const h1p = hueAngle(a1p, b1)
  const h2p = hueAngle(a2p, b2)

  const dLp = L2 - L1
  const dCp = C2p - C1p

  let dhp: number
  if (C1p * C2p === 0) dhp = 0
  else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p
  else dhp = h2p - h1p > 180 ? h2p - h1p - 360 : h2p - h1p + 360
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * DEG) / 2)

  const Lbarp = (L1 + L2) / 2
  const Cbarp = (C1p + C2p) / 2

  let hbarp: number
  if (C1p * C2p === 0) hbarp = h1p + h2p
  else if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2
  else hbarp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2

  const T = 1
    - 0.17 * Math.cos((hbarp - 30) * DEG)
    + 0.24 * Math.cos(2 * hbarp * DEG)
    + 0.32 * Math.cos((3 * hbarp + 6) * DEG)
    - 0.20 * Math.cos((4 * hbarp - 63) * DEG)

  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2))
  const Rc = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7))
  const Sl = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2)
  const Sc = 1 + 0.045 * Cbarp
  const Sh = 1 + 0.015 * Cbarp * T
  const Rt = -Math.sin(2 * dTheta * DEG) * Rc

  return Math.sqrt(
    (dLp / Sl) ** 2
    + (dCp / Sc) ** 2
    + (dHp / Sh) ** 2
    + Rt * (dCp / Sc) * (dHp / Sh)
  )
}

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

export function resolveFilamentDisplay(input: FilamentColorInput): ResolvedFilamentDisplay {
  const trayInfoIdx = input.trayInfoIdx?.trim() ?? ''
  const material = resolveDisplayMaterial(trayInfoIdx, input.filamentType)
  const palette = normalizePalette(input.colors, input.color)
  const primaryColor = normalizeHexColor(input.color) ?? palette[0] ?? null
  const trayCode = normalizeTrayCode(input.trayName)
  const presetBrand = filamentPresetBrandFromId(trayInfoIdx)
  const shouldUseBambuColorNames = presetBrand == null || presetBrand === 'Bambu'
  const trayName = input.trayName?.trim() ?? ''
  const filamentType = input.filamentType?.trim() ?? ''
  const suppressRepeatedTrayName = Boolean(filamentType && shouldSuppressRepeatedTrayLabel(trayName, filamentType))

  if (trayInfoIdx && palette.length > 1) {
    const encoded = findBambuEncodedMultiColor(trayInfoIdx, palette)
      ?? (trayCode ? findBambuEncodedMultiColorAlias(trayInfoIdx, trayCode) : null)
    if (encoded) {
      return {
        name: encoded.name,
        material: encoded.material,
        colors: encoded.colors,
        rawTrayCode: trayCode
      }
    }
  }

  if (!shouldUseBambuColorNames && (!trayName || suppressRepeatedTrayName || trayCode)) {
    const commonName = commonFilamentColorName(primaryColor)
    if (commonName) {
      return {
        name: commonName,
        material,
        colors: palette.length > 0 ? palette : primaryColor ? [primaryColor] : [],
        rawTrayCode: trayCode
      }
    }
  }

  const swatch = shouldUseBambuColorNames ? bambuSwatchForHex(primaryColor, material) : null
  if (swatch) {
    return {
      name: swatch.name,
      material: swatch.material,
      colors: palette.length > 0 ? palette : [swatch.hex],
      rawTrayCode: trayCode
    }
  }

  if (!trayName) return { name: null, material, colors: palette, rawTrayCode: null }
  if (suppressRepeatedTrayName) {
    return { name: null, material, colors: palette, rawTrayCode: null }
  }

  if (trayCode) {
    return {
      name: resolveMaterialFallbackName(material, filamentType),
      material,
      colors: palette,
      rawTrayCode: trayCode
    }
  }

  return {
    name: trayName,
    material,
    colors: palette,
    rawTrayCode: trayCode
  }
}

export function resolveFilamentColorName(input: FilamentColorInput): string | null {
  return resolveFilamentDisplay(input).name
}

export function resolveProjectFilamentColorName(input: {
  color: string | null | undefined
  filamentName: string | null | undefined
  filamentType: string | null | undefined
}): string | null {
  const primaryColor = normalizeHexColor(input.color)
  if (!primaryColor) return null

  const material = bambuMaterialFromPresetName(input.filamentName?.trim() ?? '')
    ?? resolveBambuMaterial(input.filamentType)
  if (material) {
    const swatch = bambuSwatchForHex(primaryColor, material)
    if (swatch) return swatch.name
  }

  return commonFilamentColorName(primaryColor)
}

export function resolveFilamentSwatchName(input: FilamentColorInput): string | null {
  const trayInfoIdx = input.trayInfoIdx?.trim() ?? ''
  const material = resolveDisplayMaterial(trayInfoIdx, input.filamentType)
  const palette = normalizePalette(input.colors, input.color)
  const primaryColor = normalizeHexColor(input.color) ?? palette[0] ?? null
  if (!primaryColor) return null

  const presetBrand = filamentPresetBrandFromId(trayInfoIdx)
  const shouldUseBambuColorNames = presetBrand == null || presetBrand === 'Bambu'
  if (shouldUseBambuColorNames) {
    const swatch = bambuSwatchForHex(primaryColor, material)
    if (swatch) return swatch.name
  }

  return commonFilamentColorName(primaryColor)
}

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
  options: Partial<Pick<FilamentColorInput, 'trayInfoIdx' | 'trayName' | 'trayUuid'>> & { occupied?: boolean | null | undefined; remainPercent?: number | null | undefined } = {}
): boolean {
  return Boolean(
    (filamentType?.trim() ?? '')
    || normalizePalette(colors, color).length > 0
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
  const palette = normalizePalette(colors, fallbackColor)
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
  const palette = normalizePalette(colors, fallbackColor)
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

function resolveBambuMaterial(filamentType: string | null | undefined): string | null {
  const value = filamentType?.trim() ?? ''
  if (!value) return null
  return bambuMaterialFromPresetName(value) ?? bambuMaterialFromType(value)
}

function resolveDisplayMaterial(trayInfoIdx: string, filamentType: string | null | undefined): string | null {
  const presetMaterial = bambuMaterialFromPresetName(filamentPresetNameFromId(trayInfoIdx) ?? '')
  return presetMaterial ?? resolveBambuMaterial(filamentType)
}

function normalizePalette(
  colors: readonly string[] | null | undefined,
  fallbackColor: string | null | undefined
): string[] {
  const normalized = (colors ?? [])
    .map((entry) => normalizeHexColor(entry))
    .filter((entry): entry is string => entry != null)

  const unique = normalized.filter((entry, index) => normalized.indexOf(entry) === index)
  if (unique.length > 0) return unique

  const fallback = normalizeHexColor(fallbackColor)
  return fallback ? [fallback] : []
}

function normalizeHexColor(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim().toUpperCase()
  const hex = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed
  if (!/^[0-9A-F]{6}(?:[0-9A-F]{2})?$/.test(hex)) return null
  return `#${hex.slice(0, 6)}`
}

function normalizeTrayCode(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toUpperCase() ?? ''
  return /^[A-Z]\d{2}-[A-Z]\d+$/.test(trimmed) ? trimmed : null
}

function shouldSuppressRepeatedTrayLabel(trayName: string, filamentType: string): boolean {
  if (trayName.localeCompare(filamentType, undefined, { sensitivity: 'accent' }) !== 0) return false

  return GENERIC_FILAMENT_LABELS.has(filamentType.trim().toUpperCase())
}

export function isRawTrayCode(value: string | null | undefined): boolean {
  return normalizeTrayCode(value) != null
}

function resolveMaterialFallbackName(material: string | null, filamentType: string): string | null {
  if (!material) return null

  const normalizedType = filamentType.trim().toUpperCase()
  if (normalizedType === 'PLA-S' && material === 'Support for PLA') return material
  if (normalizedType === 'SUPPORT' && material.includes('Support')) return material
  return null
}

const GENERIC_FILAMENT_LABELS = new Set([
  'ABS',
  'ABS-GF',
  'ASA',
  'ASA AERO',
  'ASA-CF',
  'PA',
  'PA6-CF',
  'PA6-GF',
  'PAHT-CF',
  'PC',
  'PC FR',
  'PC-FR',
  'PET-CF',
  'PETG',
  'PETG BASIC',
  'PETG HF',
  'PETG TRANSLUCENT',
  'PETG-CF',
  'PLA',
  'PLA AERO',
  'PLA BASIC',
  'PLA DYNAMIC',
  'PLA GALAXY',
  'PLA GLOW',
  'PLA LITE',
  'PLA MARBLE',
  'PLA MATTE',
  'PLA METAL',
  'PLA SILK',
  'PLA SILK+',
  'PLA SPARKLE',
  'PLA TOUGH',
  'PLA TOUGH+',
  'PLA WOOD',
  'PLA-CF',
  'PPA-CF',
  'PPS-CF',
  'PVA',
  'TPU',
  'TPU 85A',
  'TPU 90A',
  'TPU 95A',
  'TPU 95A HF',
  'TPU FOR AMS'
])

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