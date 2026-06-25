/**
 * Pure, module-level helpers extracted from `pages/LibraryView.tsx`.
 *
 * Owns the library-view data transforms and constant tables that carry no
 * React state: the saved view-mode / sort encode-decode, library resource
 * path + sliced-output naming, the distinct-filter-value collector, and the
 * print-dialog tray/compatibility derivations (tray grouping, AMS/external
 * spool labels, status-chip presentation, and the issue formatters) shared by
 * `LibraryView`, the slice dialog stack, and `components/library/PrintModal`.
 *
 * Invariant: nothing here may touch React (no hooks, JSX, or component
 * state/props). These are deterministic helpers and constant tables so the
 * view and its sub-components can import them without pulling in render
 * concerns; keep new pure helpers here rather than re-growing the view.
 *
 * Note: a few names here (`parseLibraryViewMode`, `parseLibrarySort`,
 * `collectDistinctLibraryFilterValues`, `LIBRARY_VIEW_MODE_KEY`, ...) mirror
 * copies in `printersViewHelpers.ts` / `printerViewConstants.ts`. These are
 * deliberate per-view copies, not a shared contract; do not dedupe them.
 */
import type {
  ExternalSpool,
  FilamentCompatibilityIssue,
  LibraryFile,
  LibraryFileVersion,
  NozzleDiameterCompatibilityIssue,
  PrinterNozzleFlow,
  Printer,
  PrinterStatus,
  SceneEdit,
  SlicingCapabilities,
  SlicingProfileSummary,
  ThreeMfProjectFilament
} from '@printstream/shared'
import {
  formatNozzleDiameterLabel,
  formatNozzleLabel,
  getPrinterControlCapabilities,
  normalizeFallbackPlateLabel,
  supportsPrinterDoorSensor
} from '@printstream/shared'
import { hasLoadedFilament } from './filamentColor'
import { LIBRARY_GROUP_OPTIONS, type LibraryGroupBy } from './libraryDirectory'
import { amsUnitLetter, type PrinterTrayGroup as PrinterTrayGroupBase } from './printerTrayMapping'
import { type LibrarySort, type LibraryViewMode } from '../components/LibraryBrowser'

export const LIBRARY_VIEW_MODE_KEY = 'bambu.library.viewMode'
export const LIBRARY_SORT_KEY = 'bambu.library.sort'
export const LIBRARY_PAGE_SIZE_OPTIONS = [25, 50, 100] as const
export const LIBRARY_SORT_OPTIONS = [
  { value: 'name', label: 'Name' },
  { value: 'date', label: 'Date' },
  { value: 'size', label: 'Size' },
  { value: 'mostPrinted', label: 'Most printed' },
  { value: 'lastPrinted', label: 'Last printed' }
] as const
export const LIBRARY_GROUP_KEY = 'bambu.library.group'
export function parseLibraryGroup(raw: string): LibraryGroupBy | null {
  return LIBRARY_GROUP_OPTIONS.some((option) => option.value === raw) ? (raw as LibraryGroupBy) : null
}
export const VIRTUAL_TRAY_MAIN_ID = 255
export const VIRTUAL_TRAY_DEPUTY_ID = 254
export const AVAILABLE_PRINT_STAGES = new Set<PrinterStatus['stage']>(['idle', 'finished', 'failed', 'unknown'])
export const PUBLIC_DEMO_LIBRARY_UPLOAD_NOTICE = 'This is a public demo. Curated library files stay read-only. Uploads are private temporary files, limited to 15 MB, and removed within 12 hours.'
export const EMPTY_SLICER_TARGETS: SlicingCapabilities['targets'] = []
export const EMPTY_SLICING_PROFILES: SlicingProfileSummary[] = []

export interface PlateTypeMismatchIssue {
  requiredPlateType: string
  selectedPlateType: string | null
}

export interface PrinterTrayOption {
  mappingValue: number
  key: string
  kind: 'ams' | 'external'
  label: string
  badgeLabel: string
  groupLabel: string | null
  color: string | null
  colors: string[]
  filamentType: string | null
  trayName: string | null
  trayInfoIdx: string | null
  remainPercent: number | null
  /** Spool identity (RFID/Bambu tag). Null for third-party spools that cannot report remaining. */
  trayUuid: string | null
  nozzleId: number | null
  /** Slot reports a physical spool even though its identity is unreadable. */
  occupied?: boolean | null
  /** AMS coordinates for the spool-setup dialog (AMS trays only). */
  amsUnitId?: number
  amsSlotId?: number
}

export type PrinterTrayGroup = PrinterTrayGroupBase<PrinterTrayOption>

export function buildLibraryResourceBasePath(fileId: string, versionId: string | null = null): string {
  return versionId ? `/api/library/versions/${versionId}` : `/api/library/${fileId}`
}

export function toHistoryPrintFile(version: LibraryFileVersion): LibraryFile {
  return {
    id: version.libraryFileId,
    name: version.name,
    sizeBytes: version.sizeBytes,
    uploadedAt: version.uploadedAt,
    kind: version.kind,
    thumbnailPath: version.thumbnailPath,
    folderId: version.folderId,
    compatiblePrinterModels: version.compatiblePrinterModels,
    plateTypeChips: version.plateTypeChips,
    nozzleSizeChips: version.nozzleSizeChips,
    projectFilamentChips: version.projectFilamentChips,
    favorite: false,
    printCount: 0,
    lastPrintedAt: null
  }
}

export function buildSlicedOutputFileName(fileName: string, options?: { plateName?: string | null; plateNumber?: number | null }): string {
  const baseName = humanizeProjectName(fileName.replace(/\.3mf$/i, ''))
  const plateLabel = buildSlicedPlateLabel(options?.plateName, options?.plateNumber)
  const suffix = plateLabel ? ` - ${plateLabel}` : ''
  return `${baseName}${suffix}.gcode.3mf`
}

/** Convert underscore separators in a project file name into spaces ("Best_Shot_Golf" -> "Best Shot Golf"). */
export function humanizeProjectName(value: string): string {
  const humanized = value.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  return humanized || value.trim()
}

/** Build a human-readable plate label ("Plate 4") for a sliced output file, preserving spaces. */
export function buildSlicedPlateLabel(plateName: string | null | undefined, plateNumber: number | null | undefined): string | null {
  const normalized = plateName?.trim().replace(/\s+/g, ' ')
  if (normalized) return normalizeFallbackPlateLabel(normalized)
  if (plateNumber != null && plateNumber > 0) return `Plate ${plateNumber}`
  return null
}

export function printerHasChamber(model: Printer['model']): boolean {
  const controls = getPrinterControlCapabilities(model)
  return controls.chamberFan || controls.chamberTemperature || supportsPrinterDoorSensor(model)
}

export function parseLibraryViewMode(raw: string): LibraryViewMode | null {
  return raw === 'list' || raw === 'icon' ? raw : null
}

export function parseLibrarySort(raw: string): LibrarySort | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LibrarySort>
    const key = parsed.key
    const dir = parsed.dir
    const validKey = key === 'name' || key === 'date' || key === 'size' || key === 'mostPrinted' || key === 'lastPrinted'
    const validDir = dir === 'asc' || dir === 'desc'
    return validKey && validDir ? { key, dir } : null
  } catch {
    return null
  }
}

export function collectDistinctLibraryFilterValues(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right))
}

export function stopEventPropagation(event: { stopPropagation(): void }): void {
  event.stopPropagation()
}

/**
 * Short label shown in the printer-status chip on the print dialog's
 * printer rows. Mirrors the wording used in the previous inline text:
 * "offline" when the printer isn't reachable, the stage name otherwise,
 * with "busy" appended when the printer is online but unavailable for a
 * new dispatch (e.g. mid-print).
 */
export function printerStatusChipLabel(
  status: PrinterStatus | undefined,
  available: boolean
): string {
  if (!status?.online) return 'offline'
  if (!available) return `${status.stage} · busy`
  return status.stage === 'finished' ? 'idle' : status.stage
}

/**
 * Joy palette for the printer-status chip. Picks the most attention-worthy
 * tone for the printer's current state so the row reads at a glance.
 */
export function printerStatusChipColor(
  status: PrinterStatus | undefined,
  available: boolean
): 'neutral' | 'primary' | 'success' | 'warning' | 'danger' {
  if (!status?.online) return 'neutral'
  if (!available) return 'warning'
  switch (status.stage) {
    case 'paused':
      return 'warning'
    case 'failed':
      return 'danger'
    case 'printing':
      return 'success'
    case 'preparing':
    case 'heating':
      return 'primary'
    case 'idle':
    case 'finished':
    case 'unknown':
    default:
      return 'neutral'
  }
}

export function formatPlateTypeIssue(issue: PlateTypeMismatchIssue): string {
  if (!issue.selectedPlateType) {
    return `This file was sliced for ${issue.requiredPlateType}. Set the printer's current plate type on the Printers page or confirm the mismatch.`
  }
  return `This file was sliced for ${issue.requiredPlateType}, but the printer is set to ${issue.selectedPlateType}.`
}

export function formatNozzleDiameterIssue(issue: NozzleDiameterCompatibilityIssue, nozzleCount?: number | null): string {
  const nozzleLabel = formatNozzleLabel(issue.extruderId, 'long', nozzleCount) ?? 'Required nozzle'
  const required = formatNozzleDiameterLabel(issue.requiredDiameter) ?? issue.requiredDiameter
  if (!issue.selectedDiameter) {
    return `${nozzleLabel}: select the installed nozzle size (${required} required)`
  }
  const selected = formatNozzleDiameterLabel(issue.selectedDiameter) ?? issue.selectedDiameter
  return `${nozzleLabel}: sliced for ${required}, printer is set to ${selected}`
}

export function filamentsForMapping(
  filaments: ThreeMfProjectFilament[],
  usedIds: Set<number>
): ThreeMfProjectFilament[] {
  return filaments.filter((filament) => usedIds.size === 0 || usedIds.has(filament.id))
}

/**
 * The filaments to offer for AMS mapping on the print dialog.
 *
 * For a SLICED plate, `slice_info.config` lists exactly the filaments the plate
 * consumes, so we narrow the project palette to those (`usedIds`) — a multi-plate
 * project then shows only the selected plate's filaments.
 *
 * For an UNSLICED plate, `usedIds` is only a geometry estimate built from each
 * object's `extruder` metadata, which captures the object's *base* extruder but
 * NOT colour-PAINTED filaments (paint lives in the mesh, not the extruder field).
 * Filtering by that estimate would hide a painted secondary colour (e.g. black on
 * a white base) and make it un-mappable, so we fall back to the full project
 * palette — matching what the editor and Bambu Studio show.
 */
export function visibleMappingFilaments(
  filaments: ThreeMfProjectFilament[],
  usedIds: Set<number>,
  plateIsSliced: boolean
): ThreeMfProjectFilament[] {
  return plateIsSliced ? filamentsForMapping(filaments, usedIds) : filaments
}

export function trayHasLoadedFilament(tray: Pick<PrinterTrayOption, 'filamentType' | 'color' | 'colors' | 'trayInfoIdx' | 'trayName'>): boolean {
  return hasLoadedFilament(tray.filamentType, tray.color, tray.colors, {
    trayInfoIdx: tray.trayInfoIdx,
    trayName: tray.trayName
  })
}

/**
 * A spool is physically present but the printer couldn't identify it (no type,
 * colour, or tray identity). The printers view marks these with a warning "?";
 * mapping pickers must NOT call them "Empty".
 */
export function trayHasUnknownSpool(tray: Pick<PrinterTrayOption, 'filamentType' | 'color' | 'colors' | 'trayInfoIdx' | 'trayName' | 'occupied'>): boolean {
  return !trayHasLoadedFilament(tray) && tray.occupied === true
}

export function buildPrinterTrayGroups(status: PrinterStatus | undefined): PrinterTrayGroup[] {
  const groups: PrinterTrayGroup[] = []
  if (!status) return groups
  const nozzleCount = status.nozzles.length > 0 ? status.nozzles.length : null
  if (status.externalSpools.length > 0) {
    groups.push({
      key: 'external',
      label: 'External Spool',
      trays: status.externalSpools.map((spool) => ({
        mappingValue: spool.amsId,
        key: `external-${spool.amsId}`,
        kind: 'external',
        label: externalSpoolLabel(spool, status.externalSpools.length),
        badgeLabel: externalSpoolLabel(spool, status.externalSpools.length),
        groupLabel: 'External Spool',
        color: spool.color,
        colors: spool.colors,
        filamentType: spool.filamentType,
        trayName: spool.trayName,
        trayInfoIdx: spool.trayInfoIdx,
        remainPercent: spool.remainPercent,
        trayUuid: spool.trayUuid,
        nozzleId: spool.nozzleId
      }))
    })
  }
  for (const unit of status.ams) {
    const groupLabel = `AMS ${amsUnitLetter(unit.unitId)}`
    groups.push({
      key: `ams-${unit.unitId}`,
      label: [
        groupLabel,
        formatNozzleLabel(unit.nozzleId, 'long', nozzleCount)
      ].filter(Boolean).join(' · '),
      trays: unit.slots.map((slot) => ({
        mappingValue: unit.unitId * 4 + slot.slot,
        key: `ams-${unit.unitId}-${slot.slot}`,
        kind: 'ams',
        label: `Slot ${slot.slot + 1}`,
        badgeLabel: `${amsUnitLetter(unit.unitId)}${slot.slot + 1}`,
        groupLabel,
        color: slot.color,
        colors: slot.colors,
        filamentType: slot.filamentType,
        trayName: slot.trayName,
        trayInfoIdx: slot.trayInfoIdx,
        remainPercent: slot.remainPercent,
        trayUuid: slot.trayUuid,
        nozzleId: unit.nozzleId,
        occupied: slot.occupied ?? null,
        amsUnitId: unit.unitId,
        amsSlotId: slot.slot
      }))
    })
  }
  return groups
}

export function buildPrinterTrayMap(status: PrinterStatus | undefined): Map<number, PrinterTrayOption> {
  return new Map(
    buildPrinterTrayGroups(status).flatMap((group) => group.trays.map((tray) => [tray.mappingValue, tray] as const))
  )
}

export function printerHasSelectableTrays(status: PrinterStatus | undefined): boolean {
  if (!status) return false
  if (status.externalSpools.length > 0) return true
  return status.ams.some((unit) => unit.slots.length > 0)
}

export function isExternalSpoolMappingValue(value: number): boolean {
  return value === VIRTUAL_TRAY_MAIN_ID || value === VIRTUAL_TRAY_DEPUTY_ID
}

export function externalSpoolLabel(spool: ExternalSpool, spoolCount: number): string {
  if (spoolCount > 1) {
    return spool.amsId === VIRTUAL_TRAY_MAIN_ID ? 'Ext-R' : 'Ext-L'
  }
  return 'Ext'
}

export function formatCompatibilityIssue(issue: FilamentCompatibilityIssue, nozzleCount?: number | null): string {
  const subject = `#${issue.filamentId} ${issue.requiredFilamentName ?? issue.requiredFilamentType ?? 'filament'}`
  const trayLabel = issue.trayLabel ?? 'selected tray'
  const parts: string[] = []

  if (issue.typeMismatch) {
    parts.push(`${trayLabel} has ${issue.selectedFilamentType ?? 'an unknown material'}, expected ${issue.requiredFilamentType ?? 'the sliced material'}`)
  }
  if (issue.nozzleMismatch) {
    parts.push(`${trayLabel} feeds ${formatNozzleLabel(issue.trayNozzleId, 'long', nozzleCount) ?? 'the wrong nozzle'}, expected ${formatNozzleLabel(issue.nozzleId, 'long', nozzleCount) ?? 'the target nozzle'}`)
  }

  return `${subject}: ${parts.join('; ')}`
}

export function getSelectedTrayWarningMessages(input: {
  mapping: number[]
  trayByMappingValue: Map<number, PrinterTrayOption>
  filaments: ThreeMfProjectFilament[]
  timelapse: boolean
  status: PrinterStatus | undefined
}): string[] {
  const warnings = new Set<string>()
  let hasAms = false
  let hasExternal = false

  for (const filament of input.filaments) {
    const mappingValue = input.mapping[filament.id - 1]
    if (typeof mappingValue !== 'number' || mappingValue < 0) continue
    const tray = input.trayByMappingValue.get(mappingValue)
    if (!tray) continue
    hasAms = hasAms || tray.kind === 'ams'
    hasExternal = hasExternal || tray.kind === 'external'
    if (!tray.filamentType && !tray.trayInfoIdx) {
      warnings.add('One or more selected trays have unknown filament details. Check the printer before starting the print.')
    }
  }

  if (hasAms && hasExternal) {
    warnings.add('This tray assignment mixes AMS slots and external spools. Review the mapping before printing.')
  }
  if (input.timelapse && input.status?.sdCardPresent === false) {
    warnings.add('Timelapse is enabled, but the printer reports no SD card.')
  }

  return Array.from(warnings)
}

export function resolvePrinterNozzleCount(printer: Printer, status: PrinterStatus | undefined): number | null {
  if (status?.nozzles.length) return status.nozzles.length
  if (printer.currentNozzleDiameters.length > 0) return printer.currentNozzleDiameters.length
  return null
}

/**
 * Which way a `SliceFileModal` submission resolves: persist the sliced output
 * to the library (`save`), hand off to printer selection (`print`), or run a
 * hidden no-save slice that opens the results dialog (`slice`). Shared between
 * the `SliceFileModal` `onSubmit` signature and the `LibraryView` mutation that
 * consumes it.
 */
export type SliceFileSubmitAction = 'save' | 'print' | 'slice'

/**
 * Payload the slice/editor dialog (`SliceFileModal`) emits on submit. Carries
 * the chosen slicer target, resolved printer/process/filament target, output
 * naming, plate scope, and (for the interactive editor) an authoritative
 * multi-plate `sceneEdit`. Shared with `LibraryView` (and, via `ComponentProps`,
 * the printers/orders flows) so both sides agree on the wire shape.
 */
export type SliceFileSubmitInput = {
  slicerTargetId: string
  target: {
    mode: 'realPrinter' | 'manualProfile'
    printerId?: string
    printerProfileId: string
    printerModel?: string
    plateType?: string | null
    nozzleDiameters?: number[]
    toolheads?: Array<{ id: string; label: string; nozzleDiameter?: number | null; nozzleFlow?: PrinterNozzleFlow | null; position?: 'left' | 'right' | 'single' | null }>
    processProfileId?: string | null
    processSettingOverrides?: Record<string, string | string[]>
    filamentMappings?: Array<{ projectFilamentId: number; profileId?: string | null; material?: string | null; color?: string | null; source?: 'ams' | 'externalSpool' | 'manual'; trayId?: number | null }>
  }
  outputFileName: string
  outputFolderId?: string | null
  plate: number
  /** Object ids (Bambu `object_id`) to keep; omitted ⇒ all. Only used for single-plate slices. */
  selectedObjectIds?: number[]
  /** Per-object process overrides keyed by `object_id`; only used for single-plate slices. */
  objectProcessOverrides?: Record<string, Record<string, string | string[]>>
  /** Edited multi-plate arrangement from the interactive 3D editor; authoritative when present. */
  sceneEdit?: SceneEdit
}
