/**
 * Shared helpers for comparing sliced filament requirements against the
 * printer tray selections chosen in the UI or enforced by the API.
 */
import type { PrinterModel } from './printer.js'

export interface FilamentCompatibilityRequirement {
  filamentId: number
  filamentType: string | null
  filamentName: string | null
  nozzleId?: number | null
}

export interface FilamentCompatibilityTray {
  filamentType: string | null
  label?: string | null
  nozzleId?: number | null
}

export interface PrinterNozzleDiameterSelection {
  extruderId: number
  diameter: string | null
}

import type { PrinterStatus } from './printer.js'

export interface FilamentCompatibilityIssue {
  filamentId: number
  requiredFilamentType: string | null
  requiredFilamentName: string | null
  requiredFamily: string | null
  selectedFilamentType: string | null
  selectedFamily: string | null
  trayLabel: string | null
  nozzleId: number | null
  trayNozzleId: number | null
  typeMismatch: boolean
  nozzleMismatch: boolean
}

const FILAMENT_FAMILY_PATTERNS: Array<{ family: string; pattern: RegExp }> = [
  { family: 'SUPPORT-PLA', pattern: /SUPPORT\s*[-_/ ]*PLA|PLA\s*[-_/ ]*SUPPORT/i },
  { family: 'SUPPORT-PETG', pattern: /SUPPORT\s*[-_/ ]*PETG|PETG\s*[-_/ ]*SUPPORT/i },
  { family: 'BVOH', pattern: /\bBVOH\b/i },
  { family: 'PVA', pattern: /\bPVA\b/i },
  { family: 'HIPS', pattern: /\bHIPS\b/i },
  { family: 'PCTG', pattern: /\bPCTG\b/i },
  { family: 'PETG', pattern: /\bPETG\b/i },
  { family: 'PLA', pattern: /\bPLA\b/i },
  { family: 'ASA', pattern: /\bASA\b/i },
  { family: 'ABS', pattern: /\bABS\b/i },
  { family: 'PC', pattern: /\bPC\b|POLYCARBONATE/i },
  { family: 'PA', pattern: /\bPA(?:6|12|66|CF|GF)?\b|\bNYLON\b/i },
  { family: 'PP', pattern: /\bPP\b|POLYPROPYLENE/i },
  { family: 'TPU', pattern: /\bTPU\b|\bTPE\b|\bFLEX(?:IBLE)?\b/i },
  { family: 'PEEK', pattern: /\bPEEK\b/i },
  { family: 'PEI', pattern: /\bPEI\b|\bULTEM\b/i },
  { family: 'PPS', pattern: /\bPPS\b/i },
  { family: 'SUPPORT', pattern: /\bSUPPORT\b|BREAKAWAY|INTERFACE/i }
]

const PRINTER_COMPATIBILITY_FAMILIES: readonly (readonly PrinterModel[])[] = [
  ['X1C', 'X1E', 'P1S']
]

export function normalizeFilamentFamily(value: string | null | undefined): string | null {
  if (!value) return null
  const canonical = value
    .trim()
    .toUpperCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')

  if (!canonical) return null
  for (const { family, pattern } of FILAMENT_FAMILY_PATTERNS) {
    if (pattern.test(canonical)) return family
  }
  return canonical
}

export function areFilamentTypesCompatible(
  requiredType: string | null | undefined,
  selectedType: string | null | undefined
): boolean {
  const requiredFamily = normalizeFilamentFamily(requiredType)
  const selectedFamily = normalizeFilamentFamily(selectedType)
  if (!requiredFamily || !selectedFamily) return true
  return requiredFamily === selectedFamily
}

export function trayCanSatisfyRequirement(
  requirement: FilamentCompatibilityRequirement,
  tray: FilamentCompatibilityTray
): boolean {
  if (!areFilamentTypesCompatible(requirement.filamentType, tray.filamentType)) {
    return false
  }

  const requiredNozzleId = numberOrNull(requirement.nozzleId)
  const trayNozzleId = numberOrNull(tray.nozzleId)
  if (requiredNozzleId === null) return true
  if (trayNozzleId === null) return true
  return requiredNozzleId === trayNozzleId
}

export function isPrinterModelCompatible(
  compatibleModels: readonly PrinterModel[] | null | undefined,
  printerModel: PrinterModel | null | undefined
): boolean {
  if (!compatibleModels || compatibleModels.length === 0) return true
  if (!printerModel || printerModel === 'unknown') return false
  if (compatibleModels.includes(printerModel)) return true

  const printerFamily = findPrinterCompatibilityFamily(printerModel)
  if (!printerFamily) return false
  return compatibleModels.some((model) => printerFamily.includes(model))
}

function findPrinterCompatibilityFamily(model: PrinterModel): readonly PrinterModel[] | null {
  return PRINTER_COMPATIBILITY_FAMILIES.find((family) => family.includes(model)) ?? null
}

export function normalizePlateType(value: string | null | undefined): string | null {
  if (!value) return null
  const normalized = value.trim().replace(/\s+/g, ' ')
  return normalized || null
}

export function isPlateTypeCompatible(
  requiredPlateType: string | null | undefined,
  selectedPlateType: string | null | undefined
): boolean {
  const required = normalizePlateType(requiredPlateType)
  const selected = normalizePlateType(selectedPlateType)
  if (!required || !selected) return true
  return required.toUpperCase() === selected.toUpperCase()
}

export function normalizeNozzleDiameter(value: string | null | undefined): string | null {
  if (!value) return null
  const numeric = Number.parseFloat(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return numeric.toString()
}

export function formatNozzleDiameterLabel(value: string | null | undefined): string | null {
  const normalized = normalizeNozzleDiameter(value)
  return normalized ? `${normalized} mm` : null
}

export function getDetectedPrinterNozzleDiameters(
  status: Pick<PrinterStatus, 'nozzles'> | null | undefined
): PrinterNozzleDiameterSelection[] {
  if (!status || status.nozzles.length === 0) return []

  return status.nozzles
    .map((nozzle) => ({
      extruderId: nozzle.extruderId,
      diameter: normalizeNozzleDiameter(nozzle.diameter)
    }))
    .filter((entry) => entry.diameter !== null)
    .sort((left, right) => left.extruderId - right.extruderId)
}

export function resolvePrinterNozzleDiameters(
  status: Pick<PrinterStatus, 'nozzles'> | null | undefined,
  savedSelections: readonly PrinterNozzleDiameterSelection[] | null | undefined
): PrinterNozzleDiameterSelection[] {
  const resolved = new Map<number, string | null>()

  for (const selection of savedSelections ?? []) {
    const extruderId = numberOrNull(selection.extruderId)
    if (extruderId === null || resolved.has(extruderId)) continue
    resolved.set(extruderId, normalizeNozzleDiameter(selection.diameter))
  }

  for (const selection of getDetectedPrinterNozzleDiameters(status)) {
    resolved.set(selection.extruderId, selection.diameter)
  }

  return Array.from(resolved.entries())
    .map(([extruderId, diameter]) => ({ extruderId, diameter }))
    .sort((left, right) => left.extruderId - right.extruderId)
}

export function buildRequiredNozzleDiametersByExtruder(
  requirements: ReadonlyArray<{ nozzleId?: number | null; nozzleDiameter?: string | null }>,
  fallbackDiameters?: readonly string[] | null
): Map<number, string> {
  const required = new Map<number, string>()

  for (const requirement of requirements) {
    const nozzleId = numberOrNull(requirement.nozzleId)
    const nozzleDiameter = normalizeNozzleDiameter(requirement.nozzleDiameter)
    if (nozzleId === null || !nozzleDiameter || required.has(nozzleId)) continue
    required.set(nozzleId, nozzleDiameter)
  }

  if (required.size > 0) return required

  const fallback = Array.from(new Set(
    (fallbackDiameters ?? [])
      .map((value) => normalizeNozzleDiameter(value))
      .filter((value): value is string => Boolean(value))
  ))
  if (fallback.length === 1) required.set(0, fallback[0] ?? '')
  return required
}

export interface NozzleDiameterCompatibilityIssue {
  extruderId: number
  requiredDiameter: string
  selectedDiameter: string | null
}

export function findNozzleDiameterCompatibilityIssues(
  requiredByExtruder: ReadonlyMap<number, string>,
  selectedNozzles: readonly PrinterNozzleDiameterSelection[]
): NozzleDiameterCompatibilityIssue[] {
  const selectedByExtruder = new Map<number, string | null>()
  for (const selection of selectedNozzles) {
    const extruderId = numberOrNull(selection.extruderId)
    if (extruderId === null || selectedByExtruder.has(extruderId)) continue
    selectedByExtruder.set(extruderId, normalizeNozzleDiameter(selection.diameter))
  }

  const issues: NozzleDiameterCompatibilityIssue[] = []
  for (const [extruderId, requiredDiameter] of requiredByExtruder) {
    const selectedDiameter = selectedByExtruder.get(extruderId) ?? null
    if (selectedDiameter === requiredDiameter) continue
    issues.push({ extruderId, requiredDiameter, selectedDiameter })
  }

  return issues
}

export function formatNozzleLabel(
  nozzleId: number | null | undefined,
  variant: 'short' | 'long' = 'short',
  nozzleCount?: number | null
): string | null {
  if (nozzleId == null || !Number.isFinite(nozzleId)) return null
  if (nozzleId === 0 && nozzleCount != null && nozzleCount <= 1) {
    return variant === 'short' ? 'Nozzle' : 'nozzle'
  }
  if (nozzleId === 0) return variant === 'short' ? 'Nozzle R' : 'Right nozzle'
  if (nozzleId === 1) return variant === 'short' ? 'Nozzle L' : 'Left nozzle'
  return variant === 'short' ? `Nozzle ${nozzleId}` : `Nozzle ${nozzleId}`
}

export function findFilamentCompatibilityIssues(
  requirements: readonly FilamentCompatibilityRequirement[],
  selectedTraysByFilamentId: ReadonlyMap<number, FilamentCompatibilityTray>
): FilamentCompatibilityIssue[] {
  const issues: FilamentCompatibilityIssue[] = []

  for (const requirement of requirements) {
    const tray = selectedTraysByFilamentId.get(requirement.filamentId)
    if (!tray) continue

    const requiredFamily = normalizeFilamentFamily(requirement.filamentType)
    const selectedFamily = normalizeFilamentFamily(tray.filamentType)
    const nozzleId = numberOrNull(requirement.nozzleId)
    const trayNozzleId = numberOrNull(tray.nozzleId)
    const nozzleMismatch =
      nozzleId !== null && trayNozzleId !== null && nozzleId !== trayNozzleId
    const typeMismatch = !areFilamentTypesCompatible(
      requirement.filamentType,
      tray.filamentType
    )

    if (!typeMismatch && !nozzleMismatch) continue

    issues.push({
      filamentId: requirement.filamentId,
      requiredFilamentType: requirement.filamentType ?? null,
      requiredFilamentName: requirement.filamentName ?? null,
      requiredFamily,
      selectedFilamentType: tray.filamentType ?? null,
      selectedFamily,
      trayLabel: tray.label ?? null,
      nozzleId,
      trayNozzleId,
      typeMismatch,
      nozzleMismatch
    })
  }

  return issues
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}