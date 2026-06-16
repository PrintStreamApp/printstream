/**
 * Shared filament setup catalog: common filament types with default nozzle temperature
 * ranges, plus the Bambu preset list grouped by brand. Used by every "configure this
 * spool" surface (the printers view's AMS/external editors and the print-flow
 * spool-setup dialog) so type/temp/preset behavior stays identical everywhere.
 */
import { BAMBU_FILAMENT_PRESET_NAMES, brandFromPresetName } from './bambuFilamentPresets'

/**
 * Common Bambu filament types and their default nozzle temperature ranges.
 * Selecting a preset auto-fills the temp inputs but the user can still
 * override them. Unknown / custom types fall through to the current value.
 */
export const FILAMENT_PRESETS: Array<{ type: string; tempMin: number; tempMax: number }> = [
  { type: 'PLA', tempMin: 190, tempMax: 230 },
  { type: 'PETG', tempMin: 220, tempMax: 250 },
  { type: 'PETG-ESD', tempMin: 240, tempMax: 270 },
  { type: 'PETG-CF', tempMin: 240, tempMax: 270 },
  { type: 'PCTG', tempMin: 240, tempMax: 270 },
  { type: 'ABS', tempMin: 230, tempMax: 270 },
  { type: 'ABS-GF', tempMin: 240, tempMax: 270 },
  { type: 'ASA', tempMin: 240, tempMax: 270 },
  { type: 'ASA-CF', tempMin: 250, tempMax: 280 },
  { type: 'TPU', tempMin: 200, tempMax: 230 },
  { type: 'PA', tempMin: 260, tempMax: 290 },
  { type: 'PA-CF', tempMin: 260, tempMax: 300 },
  { type: 'PAHT-CF', tempMin: 260, tempMax: 300 },
  { type: 'PA6-CF', tempMin: 260, tempMax: 300 },
  { type: 'PA6-GF', tempMin: 260, tempMax: 300 },
  { type: 'PA12-CF', tempMin: 260, tempMax: 300 },
  { type: 'PA612-CF', tempMin: 260, tempMax: 300 },
  { type: 'PPA', tempMin: 280, tempMax: 320 },
  { type: 'PPA-CF', tempMin: 280, tempMax: 320 },
  { type: 'PPA-GF', tempMin: 280, tempMax: 320 },
  { type: 'PC', tempMin: 250, tempMax: 280 },
  { type: 'PP', tempMin: 220, tempMax: 250 },
  { type: 'PE', tempMin: 220, tempMax: 260 },
  { type: 'PET-CF', tempMin: 260, tempMax: 290 },
  { type: 'PPS', tempMin: 300, tempMax: 340 },
  { type: 'PPS-CF', tempMin: 300, tempMax: 340 },
  { type: 'PVA', tempMin: 190, tempMax: 220 },
  { type: 'BVOH', tempMin: 190, tempMax: 220 },
  { type: 'HIPS', tempMin: 230, tempMax: 260 },
  { type: 'PHA', tempMin: 190, tempMax: 230 },
  { type: 'EVA', tempMin: 190, tempMax: 230 },
  { type: 'PLA-CF', tempMin: 220, tempMax: 240 },
  { type: 'SUPPORT', tempMin: 190, tempMax: 230 }
]

export const FILAMENT_TYPE_ORDER = [
  'PAHT-CF', 'PA12-CF', 'PA612-CF', 'PETG-ESD', 'PETG-CF', 'PLA-CF', 'ABS-GF', 'ASA-CF',
  'PA6-CF', 'PA6-GF', 'PPA-CF', 'PPA-GF', 'PET-CF', 'PPS-CF', 'PCTG', 'PETG', 'PLA',
  'ABS', 'ASA', 'TPU', 'PVA', 'BVOH', 'HIPS', 'PPS', 'PC', 'PPA', 'PA', 'PP', 'PE', 'PHA', 'EVA'
]

export const BAMBU_FILAMENT_PRESETS = Object.entries(BAMBU_FILAMENT_PRESET_NAMES).map(([id, name]) => {
  const type = filamentTypeFromPresetName(name)
  const temps = filamentTypeDefaults(type)
  const brand = brandFromPresetName(name)
  return { id, name, type, brand, tempMin: temps?.tempMin, tempMax: temps?.tempMax }
})

const BRAND_ORDER = ['Bambu', 'Generic', 'PolyLite', 'PolyTerra', 'Overture', 'eSUN', 'Fiberon']

export const BAMBU_FILAMENT_PRESET_GROUPS = (() => {
  const byBrand = new Map<string, typeof BAMBU_FILAMENT_PRESETS>()
  for (const preset of BAMBU_FILAMENT_PRESETS) {
    const list = byBrand.get(preset.brand) ?? []
    list.push(preset)
    byBrand.set(preset.brand, list)
  }
  for (const list of byBrand.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name))
  }
  const brands = Array.from(byBrand.keys()).sort((a, b) => {
    const ai = BRAND_ORDER.indexOf(a)
    const bi = BRAND_ORDER.indexOf(b)
    if (ai !== -1 && bi !== -1) return ai - bi
    if (ai !== -1) return -1
    if (bi !== -1) return 1
    return a.localeCompare(b)
  })
  return brands.map((brand) => ({ brand, presets: byBrand.get(brand)! }))
})()

export function filamentTypeDefaults(type: string | null | undefined) {
  if (!type) return null
  const exact = FILAMENT_PRESETS.find((entry) => entry.type === type)
  if (exact) return exact
  const baseType = type.split('-')[0]
  return FILAMENT_PRESETS.find((entry) => entry.type === baseType) ?? null
}

export function filamentTypeFromPresetName(name: string): string {
  const normalized = name.toUpperCase()
  if (normalized.includes('SUPPORT')) return 'SUPPORT'
  for (const type of FILAMENT_TYPE_ORDER) {
    if (normalized.includes(type)) return type
  }
  return 'PLA'
}

/**
 * Edit a single AMS tray's filament details. Sends an `ams_filament_setting`
 * MQTT command via the API and lets the next status push update the UI.
 *
 * When the slot holds an RFID-tagged Bambu spool (`trayUuid` set), the
 * filament fields are read from the spool itself and editing is
 * disabled. The dialog instead shows the read-only properties plus a
 * Rescan button which re-pulls the printer's current status.
 */
