/**
 * Library-print compatibility guard.
 *
 * Compares the sliced filament requirements for a selected 3MF plate with
 * the trays the user mapped in the print dialog. The API uses this as a
 * final safety net so stale browser state or third-party clients cannot
 * silently dispatch obvious material mismatches.
 */
import {
  amsTrayIndex,
  amsUnitLetter,
  buildRequiredNozzleDiametersByExtruder,
  findFilamentCompatibilityIssues,
  findNozzleDiameterCompatibilityIssues,
  formatNozzleDiameterLabel,
  formatNozzleLabel,
  resolvePrinterNozzleDiameters,
  isPlateTypeCompatible,
  isPrinterModelCompatible,
  trayCanSatisfyRequirement,
  type FilamentCompatibilityIssue,
  type PrinterNozzleDiameterSelection,
  type PrinterModel,
  type PrinterStatus
} from '@printstream/shared'
import { conflict } from './http-error.js'
import type { ThreeMfIndex } from './three-mf.js'

interface LibraryPrintCompatibilityIndexInput {
  plate: number
  printerModel: PrinterModel
  printerStatus: PrinterStatus | undefined
  amsMapping?: number[]
  allowIncompatibleFilament?: boolean
  allowPlateTypeMismatch?: boolean
  currentPlateType?: string | null
  currentNozzleDiameters?: PrinterNozzleDiameterSelection[]
}

interface AutomaticPrintCompatibilityInput {
  index: ThreeMfIndex | null
  plate: number
  printerModel: PrinterModel
  printerStatus: PrinterStatus | undefined
  useAms: boolean
  amsMapping?: number[]
  allowIncompatibleFilament?: boolean
}

interface AutomaticCompatibilityIssue {
  filamentId: number
  filamentType: string | null
  filamentName: string | null
  nozzleId: number | null
}

export function assertLibraryPrintCompatibilityForIndex(
  index: ThreeMfIndex,
  input: LibraryPrintCompatibilityIndexInput
): void {
  assertCompatiblePrinterModel(index.compatiblePrinterModels, input.printerModel)
  assertPrinterHardwareCompatibility(index, input)
  const issues = getLibraryPrintCompatibilityIssues(index, input)
  // Nozzle-mismatch issues are overridable too: the tray→nozzle binding comes
  // from status parsing that can be wrong (H2D AMS/nozzle parsing is unverified
  // against live hardware), so a confirmed `allowIncompatibleFilament` must be
  // able to dispatch a physically-correct setup the parser misreads.
  if (input.allowIncompatibleFilament || issues.length === 0) return
  throw conflict(formatCompatibilityMessage(issues))
}

export function assertAutomaticPrintCompatibility(
  input: AutomaticPrintCompatibilityInput
): void {
  assertCompatiblePrinterModel(input.index?.compatiblePrinterModels ?? [], input.printerModel)
  if (input.allowIncompatibleFilament) return
  const issues = getAutomaticPrintCompatibilityIssues(input)
  if (issues.length === 0) return
  throw conflict(formatAutomaticCompatibilityMessage(issues))
}

function getLibraryPrintCompatibilityIssues(
  index: ThreeMfIndex,
  input: LibraryPrintCompatibilityIndexInput
): FilamentCompatibilityIssue[] {
  if (!input.printerStatus || !input.amsMapping || input.amsMapping.length === 0) return []

  const plate = index.plates.find((entry) => entry.index === input.plate) ?? index.plates[0]
  if (!plate) return []

  const trayByMappingValue = buildTrayLookup(input.printerStatus)
  const selectedTrays = new Map<number, { filamentType: string | null; label: string; nozzleId: number | null }>()
  for (const filament of plate.filaments) {
    const mappingValue = input.amsMapping[filament.id - 1]
    if (typeof mappingValue !== 'number' || !Number.isInteger(mappingValue) || mappingValue < 0) continue
    const tray = trayByMappingValue.get(mappingValue)
    if (!tray) continue
    selectedTrays.set(filament.id, tray)
  }

  return findFilamentCompatibilityIssues(
    plate.filaments.map((filament) => ({
      filamentId: filament.id,
      filamentType: filament.filamentType,
      filamentName: filament.filamentName,
      nozzleId: filament.nozzleId
    })),
    selectedTrays
  )
}

function assertPrinterHardwareCompatibility(
  index: ThreeMfIndex,
  input: LibraryPrintCompatibilityIndexInput
): void {
  const plate = index.plates.find((entry) => entry.index === input.plate) ?? index.plates[0]
  if (!plate) return

  if (plate.plateType && !input.allowPlateTypeMismatch) {
    if (!input.currentPlateType) {
      throw conflict(`This plate was sliced for ${plate.plateType}. Choose the printer's current plate type or confirm the mismatch in the print dialog.`)
    }
    if (!isPlateTypeCompatible(plate.plateType, input.currentPlateType)) {
      throw conflict(`This plate was sliced for ${plate.plateType}, but the current printer plate is ${input.currentPlateType}. Confirm the mismatch in the print dialog to continue.`)
    }
  }

  const requiredNozzleDiameters = buildRequiredNozzleDiametersByExtruder(plate.filaments, plate.nozzleSizes)
  if (requiredNozzleDiameters.size === 0) return
  const effectiveNozzleDiameters = resolvePrinterNozzleDiameters(input.printerStatus, input.currentNozzleDiameters)

  // An undetected/unset diameter is "unknown", not "incompatible": the status
  // parser can fail to populate an extruder's diameter (seen on H2D), and
  // refusing a valid print because *we* could not detect the nozzle is the
  // wrong default. Only a positively conflicting diameter blocks dispatch;
  // the web dialog still warns on unknowns so the user can fix the setting.
  const issues = findNozzleDiameterCompatibilityIssues(requiredNozzleDiameters, effectiveNozzleDiameters)
    .filter((issue) => issue.selectedDiameter !== null)
  if (issues.length === 0) return

  const details = issues.map((issue) => {
    const nozzleLabel = formatNozzleLabel(issue.extruderId, 'long') ?? 'required nozzle'
    const requiredDiameter = formatNozzleDiameterLabel(issue.requiredDiameter) ?? issue.requiredDiameter
    const selectedDiameter = formatNozzleDiameterLabel(issue.selectedDiameter) ?? issue.selectedDiameter
    return `${nozzleLabel}: sliced for ${requiredDiameter}, printer is set to ${selectedDiameter}`
  })
  throw conflict(`Installed nozzle size does not match the sliced file. ${details.join(' | ')}.`)
}

function buildTrayLookup(status: PrinterStatus): Map<number, { filamentType: string | null; label: string; nozzleId: number | null }> {
  const trays = new Map<number, { filamentType: string | null; label: string; nozzleId: number | null }>()

  for (const spool of status.externalSpools) {
    trays.set(spool.amsId, {
      filamentType: spool.filamentType,
      label: externalSpoolLabel(spool.amsId, status.externalSpools.length),
      nozzleId: spool.nozzleId
    })
  }

  for (const unit of status.ams) {
    for (const slot of unit.slots) {
      trays.set(amsTrayIndex(unit.type, unit.unitId, slot.slot), {
        filamentType: slot.filamentType,
        label: `AMS ${amsUnitLetter(unit.unitId)} Slot ${slot.slot + 1}`,
        nozzleId: unit.nozzleId
      })
    }
  }

  return trays
}

function getAutomaticPrintCompatibilityIssues(
  input: AutomaticPrintCompatibilityInput
): AutomaticCompatibilityIssue[] {
  if (!input.index || !input.printerStatus) return []
  const plate = input.index.plates.find((entry) => entry.index === input.plate) ?? input.index.plates[0]
  if (!plate) return []

  const trayLookup = buildTrayLookup(input.printerStatus)
  const selectedTrays = new Map<number, { filamentType: string | null; label: string; nozzleId: number | null }>()

  if (input.amsMapping && input.amsMapping.length > 0) {
    for (const filament of plate.filaments) {
      const mappingValue = input.amsMapping[filament.id - 1]
      if (typeof mappingValue !== 'number' || !Number.isInteger(mappingValue) || mappingValue < 0) continue
      const tray = trayLookup.get(mappingValue)
      if (!tray) continue
      selectedTrays.set(filament.id, tray)
    }

    return findFilamentCompatibilityIssues(
      plate.filaments.map((filament) => ({
        filamentId: filament.id,
        filamentType: filament.filamentType,
        filamentName: filament.filamentName,
        nozzleId: filament.nozzleId
      })),
      selectedTrays
    ).map((issue) => ({
      filamentId: issue.filamentId,
      filamentType: issue.requiredFilamentType,
      filamentName: issue.requiredFilamentName,
      nozzleId: issue.nozzleId
    }))
  }

  const trays = Array.from(trayLookup.values()).filter((tray) =>
    input.useAms ? true : tray.label.startsWith('Ext')
  )

  return plate.filaments
    .filter((filament) => !trays.some((tray) => trayCanSatisfyRequirement({
      filamentId: filament.id,
      filamentType: filament.filamentType,
      filamentName: filament.filamentName,
      nozzleId: filament.nozzleId
    }, tray)))
    .map((filament) => ({
      filamentId: filament.id,
      filamentType: filament.filamentType,
      filamentName: filament.filamentName,
      nozzleId: filament.nozzleId
    }))
}

function formatCompatibilityMessage(issues: FilamentCompatibilityIssue[]): string {
  const details = issues.map((issue) => {
    const subject = issue.requiredFilamentName
      ?? issue.requiredFilamentType
      ?? `Filament #${issue.filamentId}`
    const trayLabel = issue.trayLabel ?? 'selected tray'
    const parts: string[] = []

    if (issue.typeMismatch) {
      parts.push(
        `needs ${issue.requiredFilamentType ?? 'the sliced material'} but ${trayLabel} is loaded with ${issue.selectedFilamentType ?? 'an unknown material'}`
      )
    }

    if (issue.nozzleMismatch) {
      parts.push(
        `${trayLabel} feeds the ${formatNozzleLabel(issue.trayNozzleId, 'long') ?? 'wrong nozzle'}, but this filament is assigned to the ${formatNozzleLabel(issue.nozzleId, 'long') ?? 'other nozzle'}`
      )
    }

    return `${subject}: ${parts.join('; ')}`
  })

  return `Selected tray assignments are incompatible with the sliced file. ${details.join(' | ')}. Review the mapping or confirm the incompatible print in the dialog.`
}

function formatAutomaticCompatibilityMessage(issues: AutomaticCompatibilityIssue[]): string {
  const details = issues.map((issue) => {
    const subject = issue.filamentName
      ?? issue.filamentType
      ?? `Filament #${issue.filamentId}`
    const nozzle = formatNozzleLabel(issue.nozzleId, 'long')
    return nozzle
      ? `${subject}: no compatible loaded tray was found for the ${nozzle}`
      : `${subject}: no compatible loaded tray was found`
  })
  return `No compatible loaded trays were found for the sliced file. ${details.join(' | ')}. Load matching filament or confirm the incompatible print in the dialog.`
}

function assertCompatiblePrinterModel(
  compatibleModels: readonly PrinterModel[],
  printerModel: PrinterModel
): void {
  if (isPrinterModelCompatible(compatibleModels, printerModel)) return
  if (compatibleModels.length === 0) return
  throw conflict(
    `This file is only compatible with ${compatibleModels.join(', ')} and cannot be printed on ${printerModel}.`
  )
}

function externalSpoolLabel(amsId: number, spoolCount: number): string {
  if (spoolCount > 1) return amsId === 255 ? 'Ext-R' : 'Ext-L'
  return 'Ext'
}

