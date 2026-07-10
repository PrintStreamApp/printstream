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
  normalizeHexColor,
  type FilamentColorSwatchOption
} from '@printstream/shared'

// Canonical resolution lives in @printstream/shared — re-exported here for existing consumers.
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
