/**
 * Known first-party and bundled vendor filament preset names exposed by Bambu firmware.
 *
 * The id space includes Bambu-branded, third-party branded, and Generic presets.
 * Lives in shared so both the web (brand-aware preset labels, colour naming) and
 * the API (spool ingestion, calibration identity) resolve preset ids identically.
 */
export const BAMBU_FILAMENT_PRESET_NAMES: Record<string, string> = {
  GFA00: 'Bambu PLA Basic',
  GFA01: 'Bambu PLA Matte',
  GFA02: 'Bambu PLA Metal',
  GFA05: 'Bambu PLA Silk',
  GFA06: 'Bambu PLA Silk+',
  GFA07: 'Bambu PLA Marble',
  GFA08: 'Bambu PLA Sparkle',
  GFA09: 'Bambu PLA Tough',
  GFA11: 'Bambu PLA Aero',
  GFA12: 'Bambu PLA Glow',
  GFA13: 'Bambu PLA Dynamic',
  GFA15: 'Bambu PLA Galaxy',
  GFA16: 'Bambu PLA Wood',
  GFA50: 'Bambu PLA-CF',
  GFB00: 'Bambu ABS',
  GFB01: 'Bambu ASA',
  GFB02: 'Bambu ASA-Aero',
  GFB50: 'Bambu ABS-GF',
  GFB51: 'Bambu ASA-CF',
  GFB60: 'PolyLite ABS',
  GFB98: 'Generic ASA',
  GFB99: 'Generic ABS',
  GFC00: 'Bambu PC',
  GFC01: 'Bambu PC FR',
  GFC99: 'Generic PC',
  GFG00: 'Bambu PETG Basic',
  GFG01: 'Bambu PETG Translucent',
  GFG02: 'Bambu PETG HF',
  GFG50: 'Bambu PETG-CF',
  GFG60: 'PolyLite PETG',
  GFG96: 'Generic PETG HF',
  GFG97: 'Generic PCTG',
  GFG98: 'Generic PETG-CF',
  GFG99: 'Generic PETG',
  GFL00: 'PolyLite PLA',
  GFL01: 'PolyTerra PLA',
  GFL03: 'eSUN PLA+',
  GFL04: 'Overture PLA',
  GFL05: 'Overture Matte PLA',
  GFL06: 'Fiberon PETG-ESD',
  GFL50: 'Fiberon PA6-CF',
  GFL51: 'Fiberon PA6-GF',
  GFL52: 'Fiberon PA12-CF',
  GFL53: 'Fiberon PA612-CF',
  GFL54: 'Fiberon PET-CF',
  GFL55: 'Fiberon PETG-rCF',
  GFL95: 'Generic PLA High Speed',
  GFL96: 'Generic PLA Silk',
  GFL98: 'Generic PLA-CF',
  GFL99: 'Generic PLA',
  GFN03: 'Bambu PA-CF',
  GFN04: 'Bambu PAHT-CF',
  GFN05: 'Bambu PA6-CF',
  GFN06: 'Bambu PPA-CF',
  GFN08: 'Bambu PA6-GF',
  GFN96: 'Generic PPA-GF',
  GFN97: 'Generic PPA-CF',
  GFN98: 'Generic PA-CF',
  GFN99: 'Generic PA',
  GFP95: 'Generic PP-GF',
  GFP96: 'Generic PP-CF',
  GFP97: 'Generic PP',
  GFP98: 'Generic PE-CF',
  GFP99: 'Generic PE',
  GFR98: 'Generic PHA',
  GFR99: 'Generic EVA',
  GFS00: 'Bambu Support W',
  GFS01: 'Bambu Support G',
  GFS02: 'Bambu Support For PLA',
  GFS03: 'Bambu Support For PA/PET',
  GFS04: 'Bambu PVA',
  GFS05: 'Bambu Support For PLA/PETG',
  GFS06: 'Bambu Support for ABS',
  GFS97: 'Generic BVOH',
  GFS98: 'Generic HIPS',
  GFS99: 'Generic PVA',
  GFT01: 'Bambu PET-CF',
  GFT02: 'Bambu PPS-CF',
  GFT97: 'Generic PPS',
  GFT98: 'Generic PPS-CF',
  GFU00: 'Bambu TPU 95A HF',
  GFU01: 'Bambu TPU 95A',
  GFU02: 'Bambu TPU for AMS',
  GFU98: 'Generic TPU for AMS',
  GFU99: 'Generic TPU'
}

/**
 * The filament to seed a slot with when nothing better can be resolved, a brand-new project's
 * first material, or an added slot with no template to clone. "Generic PLA" (GFL99) is a system
 * preset present for every machine and nozzle, so it is always sliceable; callers that DO know the
 * machine prefer its own `default_filament_profile` (Bambu PLA Basic) and only fall back to this.
 * White is the conventional neutral default (matches the inline `#FFFFFF` used across the slice UI).
 */
export const DEFAULT_FILAMENT_PRESET_NAME = 'Generic PLA'
export const DEFAULT_FILAMENT_COLOR = '#FFFFFF'

/**
 * The DISPLAY spelling of a filament vendor.
 *
 * BambuStudio writes `filament_vendor: "Bambu Lab"`, while every name-derived path yields "Bambu"
 * (preset names read "Bambu PLA Basic", never "Bambu Lab PLA Basic"). Presets that carry no vendor
 * field, a 3MF's own project presets, can only take the name-derived form, so without one rule
 * the same vendor appears both ways in a single picker, which reads as two different brands.
 */
export function normalizeFilamentVendorLabel(vendor: string | null | undefined): string {
  const trimmed = vendor?.trim() ?? ''
  return trimmed === 'Bambu Lab' ? 'Bambu' : trimmed
}

/**
 * Resolve the manufacturer when firmware supplies a preset name rather than a
 * vendor field. Studio's PolyLite, PolyTerra and Fiberon presets all declare
 * filament_vendor=Polymaker; their first word is a product family, not a vendor.
 * Keep this shared so AMS identity and preset-only material options agree.
 */
export function brandFromPresetName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? ''
  if (/^(polylite|polyterra|fiberon)$/i.test(first)) return 'Polymaker'
  return first || 'Other'
}

export function filamentPresetNameFromId(trayInfoIdx: string | null | undefined): string | null {
  if (!trayInfoIdx) return null
  return BAMBU_FILAMENT_PRESET_NAMES[trayInfoIdx] ?? null
}

export function filamentPresetBrandFromId(trayInfoIdx: string | null | undefined): string | null {
  const presetName = filamentPresetNameFromId(trayInfoIdx)
  return presetName ? brandFromPresetName(presetName) : null
}

/**
 * Product line from a known bundled preset, excluding its manufacturer and machine suffix.
 * Unknown/custom recipe names and Generic presets cannot establish a product identity.
 */
export function filamentProductLineFromPresetName(name: string): string | null {
  const base = name.split('@')[0]!.trim()
  const known = Object.values(BAMBU_FILAMENT_PRESET_NAMES)
    .find((candidate) => candidate.toLowerCase() === base.toLowerCase())
  if (!known) return null
  const brand = brandFromPresetName(known)
  if (brand === 'Generic') return null
  return known.startsWith(`${brand} `) ? known.slice(brand.length + 1) : known
}
