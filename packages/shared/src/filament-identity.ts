/**
 * Canonical filament identity resolution — THE single place that decides what a
 * filament is called (brand, type, subtype/preset, colour name) from raw tray,
 * spool, and preset data. Both the web and the API resolve through here so every
 * surface (AMS grids, slice dialogs, print dialogs, spool ingestion, calibration
 * identity) presents and persists the same identity for the same filament.
 *
 * The one gating rule (do not re-implement it elsewhere): Bambu MARKETING names
 * — colour names like "Jade White" and preset names like "Bambu PLA Basic" —
 * are shown only for a GENUINE Bambu filament, meaning a readable RFID tag
 * (`trayUuid`) whose preset id is Bambu's own (or unmapped). A user-assigned
 * Bambu preset id (`trayInfoIdx`) on custom filament, a matched slicing
 * profile's vendor string, or a bare filament type NEVER unlocks marketing
 * names; custom filament reads as its plain common colour ("White") and its
 * reported type. Project-side filaments (3MF materials, no tray) gate on the
 * sliced preset/brand name instead (`resolveProjectFilamentColorName`).
 *
 * Precedence within a resolved identity: tracked-spool fields (user-owned
 * truth) > genuine preset data > raw tray fields > null. Colour naming
 * precedence: encoded multi-colour match > common name (non-genuine) > Bambu
 * swatch (genuine, material-scoped) > meaningful tray name.
 */
import { normalizeHexColor } from './print-queue.js'
import { commonFilamentColorName } from './filament-color.js'
import {
  bambuMaterialFromPresetName,
  bambuMaterialFromType,
  bambuSwatchForHex
} from './bambu-colors.js'
import { brandFromPresetName, filamentPresetBrandFromId, filamentPresetNameFromId } from './bambu-filament-presets.js'
import { findBambuEncodedMultiColor, findBambuEncodedMultiColorAlias } from './bambu-encoded-multi-colors.js'

export interface ResolvedFilamentDisplay {
  name: string | null
  material: string | null
  colors: string[]
  rawTrayCode: string | null
}

/** Raw live-tray fields as reported by the printer (AMS slot / external spool). */
export interface FilamentColorInput {
  color: string | null | undefined
  colors?: readonly string[] | null | undefined
  trayName: string | null | undefined
  trayInfoIdx?: string | null | undefined
  filamentType: string | null | undefined
  trayUuid?: string | null | undefined
}

/** Optional tracked-spool identity that overrides tray-derived fields. */
export interface FilamentSpoolIdentityInput {
  brand?: string | null
  filamentType?: string | null
  materialSubtype?: string | null
  colorName?: string | null
  colorHex?: string | null
}

/** The canonical resolved identity of a physical filament. */
export interface ResolvedFilamentIdentity {
  /** Readable RFID tag with a Bambu (or unmapped) preset id — unlocks marketing names. */
  genuineBambu: boolean
  /** 'Bambu' (genuine), the tray's third-party preset brand, or the tracked spool's brand. */
  brand: string | null
  /** Filament type as reported ("PLA"); spool field wins over the tray. */
  type: string | null
  /** Bambu material family ("PLA Basic") — only when the tray's preset id declares it. */
  subtype: string | null
  /** Full preset name ("Bambu PLA Basic") — genuine Bambu only. */
  presetName: string | null
  colorHex: string | null
  colors: string[]
  colorName: string | null
  rawTrayCode: string | null
}

/**
 * A genuine Bambu spool is identified by a readable RFID tag (`trayUuid`), which the AMS only
 * reports for real Bambu filament. Only such spools — not a user-assigned Bambu slicing preset
 * (`trayInfoIdx`), which can be attached to any physical filament — should surface Bambu's
 * marketing colour names (e.g. "Jade White"). Custom/third-party filament reads as its plain
 * common colour ("White").
 */
export function hasBambuRfidTag(trayUuid: string | null | undefined): boolean {
  const value = trayUuid?.trim() ?? ''
  return value.length > 0 && !/^0+$/.test(value)
}

/** Whether the tray declares a genuinely-Bambu identity (RFID + Bambu/unmapped preset id). */
export function isGenuineBambuTray(input: Pick<FilamentColorInput, 'trayUuid' | 'trayInfoIdx'>): boolean {
  const presetBrand = filamentPresetBrandFromId(input.trayInfoIdx?.trim() ?? '')
  return hasBambuRfidTag(input.trayUuid) && (presetBrand == null || presetBrand === 'Bambu')
}

export function resolveFilamentDisplay(input: FilamentColorInput): ResolvedFilamentDisplay {
  const trayInfoIdx = input.trayInfoIdx?.trim() ?? ''
  const material = resolveDisplayMaterial(trayInfoIdx, input.filamentType)
  const palette = normalizePalette(input.colors, input.color)
  const primaryColor = normalizeHexColor(input.color) ?? palette[0] ?? null
  const trayCode = normalizeTrayCode(input.trayName)
  const shouldUseBambuColorNames = isGenuineBambuTray(input)
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

  const swatch = shouldUseBambuColorNames ? bambuSwatchForHexWithFallback(primaryColor, material) : null
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

/**
 * The canonical identity resolver. Combines the raw tray with an optional
 * tracked spool: spool fields (user-owned truth) win where present, tray
 * derivation fills the rest, and the genuine-Bambu gate controls whether
 * preset/marketing names surface at all.
 */
export function resolveFilamentIdentity(
  input: FilamentColorInput & { spool?: FilamentSpoolIdentityInput | null }
): ResolvedFilamentIdentity {
  const display = resolveFilamentDisplay(input)
  const trayInfoIdx = input.trayInfoIdx?.trim() ?? ''
  const presetName = filamentPresetNameFromId(trayInfoIdx)
  const presetBrand = presetName ? brandFromPresetName(presetName) : null
  const genuineBambu = isGenuineBambuTray(input)
  const spool = input.spool ?? null

  // Subtype only when the tray's preset id declares it — never inferred from the
  // bare filament type (that inference is what branded custom PLA "PLA Basic").
  const presetSubtype = presetName ? bambuMaterialFromPresetName(presetName) : null

  // Brand: the spool's own brand; else 'Bambu' only when genuine; else a
  // third-party preset brand the tray itself declares (e.g. PolyLite). A
  // user-assigned Bambu preset id on custom filament yields no brand claim.
  const trayBrand = genuineBambu ? 'Bambu' : (presetBrand && presetBrand !== 'Bambu' && presetBrand !== 'Generic' ? presetBrand : null)

  const colorHex = normalizeHexColor(spool?.colorHex ?? null) ?? normalizeHexColor(input.color) ?? display.colors[0] ?? null

  return {
    genuineBambu,
    brand: spool?.brand ?? trayBrand,
    type: spool?.filamentType ?? (input.filamentType?.trim() || null),
    subtype: spool?.materialSubtype ?? presetSubtype,
    presetName: genuineBambu ? presetName : null,
    colorHex,
    colors: display.colors,
    colorName: spool?.colorName ?? display.name,
    rawTrayCode: display.rawTrayCode
  }
}

/**
 * Short display label for a resolved identity — "Bambu PLA Basic · Jade White",
 * "PolyLite PLA · White", or "PLA · White" — for slot rows in print/slice
 * dialogs. Never claims a brand or preset the identity did not establish.
 */
export function filamentIdentityLabel(identity: ResolvedFilamentIdentity): string | null {
  const material = identity.presetName
    ?? [identity.brand, identity.subtype ?? identity.type].filter(Boolean).join(' ')
  const parts = [material || null, identity.colorName].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * Colour label for a filament known by its preset/brand name (slicing options, queued jobs, spool
 * library) rather than a live AMS tray. Bambu's marketing colour names apply only when the filament
 * is Bambu-branded — its `filamentName` resolves to the "Bambu" brand (e.g. "Bambu PLA Basic").
 * A generic or custom filament ("Generic PLA", a user's own brand) keeps its plain common colour
 * name even though its type maps to a Bambu material, so custom white PLA reads "White", not
 * "Jade White". Pass the brand as `filamentName` when there is no sliced preset name.
 */
export function resolveProjectFilamentColorName(input: {
  color: string | null | undefined
  filamentName: string | null | undefined
  filamentType: string | null | undefined
}): string | null {
  const primaryColor = normalizeHexColor(input.color)
  if (!primaryColor) return null

  const name = input.filamentName?.trim() ?? ''
  if (brandFromPresetName(name) === 'Bambu') {
    const material = bambuMaterialFromPresetName(name) ?? resolveBambuMaterial(input.filamentType)
    if (material) {
      const swatch = bambuSwatchForHex(primaryColor, material)
      if (swatch) return swatch.name
    }
  }

  return commonFilamentColorName(primaryColor)
}

export function resolveFilamentSwatchName(input: FilamentColorInput): string | null {
  const trayInfoIdx = input.trayInfoIdx?.trim() ?? ''
  const material = resolveDisplayMaterial(trayInfoIdx, input.filamentType)
  const palette = normalizePalette(input.colors, input.color)
  const primaryColor = normalizeHexColor(input.color) ?? palette[0] ?? null
  if (!primaryColor) return null

  if (isGenuineBambuTray(input)) {
    const swatch = bambuSwatchForHexWithFallback(primaryColor, material)
    if (swatch) return swatch.name
  }

  return commonFilamentColorName(primaryColor)
}

export function isRawTrayCode(value: string | null | undefined): boolean {
  return normalizeTrayCode(value) != null
}

/** Normalize a palette to unique `#RRGGBB` entries, falling back to the single colour. */
export function normalizeFilamentPalette(
  colors: readonly string[] | null | undefined,
  fallbackColor: string | null | undefined
): string[] {
  return normalizePalette(colors, fallbackColor)
}

/**
 * Genuine-tray swatch lookup: material-scoped first, then — because a GENUINE
 * Bambu tray's hex is authoritative even when its material family is unmapped —
 * a global fallback. Non-genuine paths must use `bambuSwatchForHex` directly
 * (material-scoped only) so custom filament never inherits another family's
 * marketing name.
 */
function bambuSwatchForHexWithFallback(hex: string | null, material: string | null) {
  return bambuSwatchForHex(hex, material) ?? (material ? bambuSwatchForHex(hex, null) : null)
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

function normalizeTrayCode(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toUpperCase() ?? ''
  return /^[A-Z]\d{2}-[A-Z]\d+$/.test(trimmed) ? trimmed : null
}

function shouldSuppressRepeatedTrayLabel(trayName: string, filamentType: string): boolean {
  if (trayName.localeCompare(filamentType, undefined, { sensitivity: 'accent' }) !== 0) return false

  return GENERIC_FILAMENT_LABELS.has(filamentType.trim().toUpperCase())
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
