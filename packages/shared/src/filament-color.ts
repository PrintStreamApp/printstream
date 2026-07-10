/**
 * Common (brand-neutral) filament colour naming, shared by the web and the API.
 *
 * `commonFilamentColorName` maps an exact hex to a curated human colour name
 * ("White", "Gray") — deliberately generic, never a Bambu marketing name
 * (those require genuine-Bambu identity gating, which stays in the web's
 * `filamentColor.ts`). `filamentColorLabel` is the storable fallback label:
 * the common name when the hex is a known swatch, otherwise the normalized
 * hex itself, so a persisted colour identity is always human-presentable and
 * never a raw printer tray code.
 */
import { normalizeHexColor } from './print-queue.js'

export interface FilamentColorSwatchOption {
  name: string
  hex: string
}

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

/** Curated common colour name for an exact hex match, or null. */
export function commonFilamentColorName(hex: string | null | undefined): string | null {
  const normalized = normalizeHexColor(hex)
  if (!normalized) return null
  return COMMON_FILAMENT_COLOR_SWATCHES.find((swatch) => swatch.hex === normalized)?.name
    ?? COMMON_FILAMENT_COLOR_ALIASES[normalized]
    ?? null
}

/**
 * Human-presentable label for a filament colour: the curated common name when
 * the hex matches a known swatch, otherwise the normalized `#RRGGBB` hex, or
 * null when unparseable. Use this when persisting a colour as part of a
 * filament identity (e.g. calibration results) so the stored value reads as a
 * colour ("White", "#F8F8F2") rather than a printer tray code.
 */
export function filamentColorLabel(hex: string | null | undefined): string | null {
  return commonFilamentColorName(hex) ?? normalizeHexColor(hex)
}
