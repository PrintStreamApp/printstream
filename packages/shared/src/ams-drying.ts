/**
 * AMS filament-drying domain logic shared by the web drying modal and the
 * API's command validation: the filament catalogue, per-material drying
 * presets, and the safety checks that mirror the printer LCD / Bambu Studio
 * protections when mixed materials are loaded.
 *
 * Preset temperatures/durations and the per-material heat-distortion limits
 * come from Bambu's official filament profiles (BambuStudio's
 * `filament_dev_ams_drying_temperature`, `..._ams_drying_time`, and
 * `..._ams_drying_heat_distortion_temperature` keys). Two invariants worth
 * knowing:
 *
 * - A slot's `occupied` flag mirrors the AMS "tray exists" bit: filament is
 *   threaded into that slot's feed path. Threaded filament deforms when the
 *   chamber exceeds its heat-distortion point (the spool itself may stay in
 *   the AMS once unthreaded), so the risk assessment only considers occupied
 *   slots — matching Bambu Studio's pre-start check.
 * - Some of Bambu's own recommended drying temperatures exceed the same
 *   material's heat-distortion limit (TPU, PVA, support). That is intentional
 *   upstream data, not a bug here: those materials are meant to be dried
 *   unthreaded.
 */
import { amsUnitLetter, type AmsUnitType } from './ams-tray-index.js'
import type { AmsUnit } from './printer-contracts.js'

export const AMS_DRYING_FILAMENT_TYPES = [
  'PLA',
  'PLA-CF',
  'PETG',
  'PETG-ESD',
  'PETG-CF',
  'ABS',
  'ABS-GF',
  'ASA',
  'ASA-CF',
  'TPU',
  'PA',
  'PA-CF',
  'PAHT-CF',
  'PA6-CF',
  'PA6-GF',
  'PA12-CF',
  'PA612-CF',
  'PPA',
  'PPA-CF',
  'PPA-GF',
  'PC',
  'PP',
  'PE',
  'PET-CF',
  'PPS',
  'PPS-CF',
  'PVA',
  'BVOH',
  'HIPS',
  'SUPPORT'
] as const

export function normalizeAmsDryingFilamentType(filamentType: string): string {
  const normalized = filamentType.trim().toUpperCase()
  const exact = AMS_DRYING_FILAMENT_TYPES.find((entry) => entry === normalized)
  if (exact) return exact

  const partial = AMS_DRYING_FILAMENT_TYPES.find((entry) => normalized.includes(entry))
  return partial ?? 'PLA'
}

export interface AmsDryingPreset {
  temperature: number
  durationHours: number
  coolingTemp: number
}

const PLA_DRYING_PRESET: AmsDryingPreset = { temperature: 45, durationHours: 12, coolingTemp: 45 }

/**
 * Recommended drying cycle per filament type. Temperatures/durations are
 * Bambu's official idle-state AMS HT values (the higher-capability hardware;
 * {@link clampDryingTemperature} brings them into range on an AMS 2 Pro).
 */
const DRYING_PRESETS: Record<string, AmsDryingPreset> = {
  PLA: PLA_DRYING_PRESET,
  'PLA-CF': { temperature: 45, durationHours: 12, coolingTemp: 45 },
  PETG: { temperature: 65, durationHours: 12, coolingTemp: 50 },
  'PETG-ESD': { temperature: 65, durationHours: 12, coolingTemp: 50 },
  'PETG-CF': { temperature: 65, durationHours: 12, coolingTemp: 50 },
  ABS: { temperature: 80, durationHours: 8, coolingTemp: 60 },
  'ABS-GF': { temperature: 80, durationHours: 8, coolingTemp: 60 },
  ASA: { temperature: 80, durationHours: 8, coolingTemp: 60 },
  'ASA-CF': { temperature: 80, durationHours: 8, coolingTemp: 60 },
  TPU: { temperature: 75, durationHours: 18, coolingTemp: 40 },
  PA: { temperature: 85, durationHours: 12, coolingTemp: 65 },
  'PA-CF': { temperature: 85, durationHours: 12, coolingTemp: 65 },
  'PAHT-CF': { temperature: 85, durationHours: 12, coolingTemp: 65 },
  'PA6-CF': { temperature: 85, durationHours: 12, coolingTemp: 65 },
  'PA6-GF': { temperature: 85, durationHours: 12, coolingTemp: 65 },
  'PA12-CF': { temperature: 85, durationHours: 12, coolingTemp: 65 },
  'PA612-CF': { temperature: 85, durationHours: 12, coolingTemp: 65 },
  PPA: { temperature: 85, durationHours: 12, coolingTemp: 65 },
  'PPA-CF': { temperature: 85, durationHours: 12, coolingTemp: 65 },
  'PPA-GF': { temperature: 85, durationHours: 12, coolingTemp: 65 },
  PC: { temperature: 80, durationHours: 8, coolingTemp: 60 },
  PP: { temperature: 60, durationHours: 12, coolingTemp: 50 },
  PE: { temperature: 45, durationHours: 12, coolingTemp: 45 },
  'PET-CF': { temperature: 80, durationHours: 12, coolingTemp: 65 },
  PPS: { temperature: 80, durationHours: 12, coolingTemp: 65 },
  'PPS-CF': { temperature: 80, durationHours: 12, coolingTemp: 65 },
  PVA: { temperature: 85, durationHours: 18, coolingTemp: 40 },
  BVOH: { temperature: 60, durationHours: 12, coolingTemp: 40 },
  HIPS: { temperature: 80, durationHours: 12, coolingTemp: 60 },
  SUPPORT: { temperature: 60, durationHours: 12, coolingTemp: 45 }
}

export function dryingPresetForFilament(filamentType: string): AmsDryingPreset {
  return DRYING_PRESETS[normalizeAmsDryingFilamentType(filamentType)] ?? PLA_DRYING_PRESET
}

export function dryingCoolingTemperature(filamentType: string): number {
  return dryingPresetForFilament(filamentType).coolingTemp
}

/**
 * Highest chamber temperature a threaded filament tolerates without
 * deforming (Bambu's per-material heat-distortion point). Drying above this
 * with the filament still fed into the slot risks warping it inside the feed
 * path; unknown materials are treated as PLA, the most sensitive common case.
 */
const MAX_SAFE_DRYING_TEMPERATURES: Record<string, number> = {
  PLA: 45,
  'PLA-CF': 45,
  PETG: 75,
  'PETG-ESD': 75,
  'PETG-CF': 75,
  ABS: 90,
  'ABS-GF': 90,
  ASA: 100,
  'ASA-CF': 100,
  TPU: 45,
  PA: 90,
  'PA-CF': 90,
  'PAHT-CF': 90,
  'PA6-CF': 90,
  'PA6-GF': 90,
  'PA12-CF': 90,
  'PA612-CF': 90,
  PPA: 165,
  'PPA-CF': 165,
  'PPA-GF': 165,
  PC: 105,
  PP: 60,
  PE: 50,
  'PET-CF': 165,
  PPS: 90,
  'PPS-CF': 90,
  PVA: 75,
  BVOH: 65,
  HIPS: 90,
  SUPPORT: 50
}

export function maxSafeAmsDryingTemperature(filamentType: string): number {
  return MAX_SAFE_DRYING_TEMPERATURES[normalizeAmsDryingFilamentType(filamentType)] ?? 45
}

export interface AmsDryingTemperatureRange {
  min: number
  max: number
}

/**
 * The drying temperature band the unit's heater physically supports, per
 * Bambu Studio: 45-65C on an AMS 2 Pro, 45-85C on an AMS HT. Unknown future
 * unit types get the conservative AMS 2 Pro band.
 */
export function amsDryingTemperatureRange(unitType: AmsUnitType): AmsDryingTemperatureRange {
  return unitType === 'ams-ht' ? { min: 45, max: 85 } : { min: 45, max: 65 }
}

export function clampDryingTemperature(temperature: number, range: AmsDryingTemperatureRange): number {
  return Math.min(range.max, Math.max(range.min, Math.round(temperature)))
}

export interface AmsDryingSlotRisk {
  /** 0-based slot id within the unit. */
  slot: number
  /** Filament type as reported by the AMS; `null` when the spool is unidentified. */
  filamentType: string | null
  /** Heat-distortion limit the requested temperature exceeds, in C. */
  maxSafeTemperature: number
}

/**
 * Slots whose threaded filament would deform at the requested drying
 * temperature. Non-empty means the caller should be warned (and, on the API
 * side, must acknowledge the risk) before the cycle starts — mirroring the
 * check Bambu Studio and the printer LCD apply.
 */
export function assessAmsDryingRisk(unit: AmsUnit, temperature: number): AmsDryingSlotRisk[] {
  if (!Number.isFinite(temperature)) return []
  const risks: AmsDryingSlotRisk[] = []
  for (const slot of unit.slots) {
    const filamentType = slot.filamentType?.trim() ? slot.filamentType.trim() : null
    const threaded = slot.occupied ?? filamentType != null
    if (!threaded) continue
    const maxSafe = maxSafeAmsDryingTemperature(filamentType ?? 'PLA')
    if (temperature > maxSafe) {
      risks.push({ slot: slot.slot, filamentType, maxSafeTemperature: maxSafe })
    }
  }
  return risks
}

/**
 * One user-facing line per flagged slot ("A2 PLA: safe up to 45°C"). Shared
 * so the web warning and the API rejection describe the same slot the same
 * way.
 */
export function formatAmsDryingRiskLabel(unitId: number, risk: AmsDryingSlotRisk): string {
  return `${amsUnitLetter(unitId)}${risk.slot + 1} ${risk.filamentType ?? 'Unidentified filament'}: safe up to ${risk.maxSafeTemperature}°C`
}

/**
 * Server-side validation for a start-drying command against the unit's live
 * state. Returns a user-facing rejection message, or `null` when the command
 * may proceed. Hardware violations always reject; heat-distortion risks
 * reject only when the caller has not acknowledged them (the web modal warns
 * the user, then sends `acknowledgeRisks`).
 */
export function validateAmsDryingStart(
  unit: AmsUnit,
  command: { temperature: number; acknowledgeRisks: boolean }
): string | null {
  if (!unit.supportDrying) {
    return 'This AMS does not support drying'
  }
  const range = amsDryingTemperatureRange(unit.type)
  if (command.temperature < range.min || command.temperature > range.max) {
    return `Drying temperature must be between ${range.min} and ${range.max}°C on this AMS`
  }
  const risks = assessAmsDryingRisk(unit, command.temperature)
  if (risks.length > 0 && !command.acknowledgeRisks) {
    const labels = risks.map((risk) => formatAmsDryingRiskLabel(unit.unitId, risk)).join('; ')
    return `Drying at ${command.temperature}°C can deform loaded filament (${labels}). Unload it or lower the temperature, or resend with acknowledgeRisks to proceed anyway.`
  }
  return null
}

/**
 * Initial drying-form values for a unit. Mirrors the printer's LCD: the
 * default profile is the loaded material with the lowest recommended drying
 * temperature, so the suggested cycle cannot harm anything else in the unit.
 * The unit's last reported cycle settings are carried over only when they
 * belong to that same profile and are still safe for what is loaded now.
 */
export function defaultAmsDryingProfile(unit: AmsUnit): {
  filamentType: string
  temperature: number
  durationHours: number
  rotateTray: boolean
} {
  const loadedTypes = unit.slots
    .filter((slot) => slot.occupied ?? Boolean(slot.filamentType?.trim()))
    .map((slot) => slot.filamentType?.trim() ? normalizeAmsDryingFilamentType(slot.filamentType) : 'PLA')
  const detectedType = loadedTypes.length > 0
    ? loadedTypes.reduce((safest, type) =>
        dryingPresetForFilament(type).temperature < dryingPresetForFilament(safest).temperature ? type : safest)
    : normalizeAmsDryingFilamentType(unit.dryFilament ?? 'PLA')
  const preset = dryingPresetForFilament(detectedType)
  const range = amsDryingTemperatureRange(unit.type)

  const reportedMatchesSelection =
    unit.dryFilament != null && normalizeAmsDryingFilamentType(unit.dryFilament) === detectedType
  const reportedTemperature =
    reportedMatchesSelection &&
    unit.dryTemperature != null &&
    unit.dryTemperature >= range.min &&
    unit.dryTemperature <= range.max &&
    assessAmsDryingRisk(unit, unit.dryTemperature).length === 0
      ? Math.round(unit.dryTemperature)
      : null
  const reportedDuration =
    reportedMatchesSelection && unit.dryDurationHours != null && unit.dryDurationHours >= 1 && unit.dryDurationHours <= 24
      ? unit.dryDurationHours
      : null

  return {
    filamentType: detectedType,
    temperature: reportedTemperature ?? clampDryingTemperature(preset.temperature, range),
    durationHours: reportedDuration ?? preset.durationHours,
    rotateTray: true
  }
}
