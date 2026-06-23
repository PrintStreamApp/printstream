/**
 * Pure, module-level helpers extracted from `pages/PrintersView.tsx`.
 *
 * Owns the printers-dashboard data transforms that carry no React state:
 * the saved-view input shaping and sort encode/decode, the printer/state
 * filter + sort comparators, AMS/filament label derivations and drying
 * presets, HMS error-code formatting, dispatch/print-option status labels,
 * and the assorted value formatters the printer cards and dialogs render.
 *
 * Invariant: nothing here may touch React (no hooks, JSX, or component
 * state/props). These are deterministic helpers and constant tables so the
 * view and its sub-components can import them without pulling in render
 * concerns; keep new pure helpers here rather than re-growing the view.
 */
import { type Dispatch, type SetStateAction } from 'react'
import {
  classifyLibraryFileKind,
  defaultPrinterCardContentSettings,
  defaultPrinterViewSort,
  formatBytes,
  formatNozzleDiameterLabel,
  normalizeFallbackPlateLabel,
  normalizeNozzleDiameter,
  normalizePlateType,
  printerCardContentSettingsSchema,
  printerViewModelFilterSchema,
  resolvePrinterNozzleDiameters,
  type AmsSlot,
  type AmsUnit,
  type ExternalSpool,
  type LibraryFile,
  type PrintDispatchJob,
  type PrintJob,
  type Printer,
  type PrinterCardContentSettings,
  type PrinterCommand,
  type PrinterControllableLightNode,
  type PrinterFanId,
  type PrinterLightMode,
  type PrinterModel,
  type PrinterNozzleDiameterSelection,
  type PrinterPrintOptionKey,
  type PrinterPrintOptionSensitivity,
  type PrinterStatus,
  type PrinterView,
  type PrinterViewInput,
  type PrinterViewSort,
  type PrinterViewStateFilter
} from '@printstream/shared'
import { formatEtaFromNow, formatMinutesDuration } from './time'
import { isRawTrayCode, resolveCompactFilamentTypeLabel } from './filamentColor'
import { BAMBU_FILAMENT_PRESETS, filamentTypeDefaults } from '../data/filamentSetupCatalog'
import { BAMBU_FILAMENT_PRESET_NAMES } from '../data/bambuFilamentPresets'
import { type DirectoryViewMode } from '../components/DirectoryControls'
import { type LibrarySort, type LibraryViewMode } from '../components/LibraryBrowser'
import { type ChunkedLibraryUploadPhase } from './chunkedLibraryUpload'

export const HISTORY_RESULTS: PrintJob['result'][] = ['success', 'failed', 'cancelled', 'unknown']

export const CARDS_PER_ROW_OPTIONS = [1, 2, 3, 4, 5, 6] as const

export const PRINTER_STATE_FILTER_OPTIONS = ['all', 'idle', 'printing', 'paused', 'error', 'offline'] as const

export const NOZZLE_DIAMETER_OPTIONS = ['0.2', '0.4', '0.6', '0.8', '1.0']

export const COMMON_PLATE_TYPES = ['Cool Plate', 'Engineering Plate', 'High Temp Plate', 'Smooth PEI Plate', 'Supertack Plate', 'Textured PEI Plate']

export const OVERVIEW_VIEW_LABEL = 'Overview'

export const DEFAULT_PRINTER_CARD_CONTENT_SETTINGS: PrinterCardContentSettings = defaultPrinterCardContentSettings

export const PRINTER_VIEW_SORT_OPTIONS: Array<{ value: PrinterViewSort; label: string }> = [
  { value: { key: 'manual', direction: 'asc' }, label: 'Manual order' },
  { value: defaultPrinterViewSort, label: 'Name A-Z' },
  { value: { key: 'name', direction: 'desc' }, label: 'Name Z-A' },
  { value: { key: 'model', direction: 'asc' }, label: 'Model A-Z' },
  { value: { key: 'model', direction: 'desc' }, label: 'Model Z-A' },
  { value: { key: 'state', direction: 'asc' }, label: 'State' },
  { value: { key: 'state', direction: 'desc' }, label: 'State (reverse)' }
]

export const AI_MONITORING_SENSITIVITY_OPTIONS: PrinterPrintOptionSensitivity[] = ['never_halt', 'low', 'medium', 'high']

export const DETECTION_SENSITIVITY_OPTIONS: PrinterPrintOptionSensitivity[] = ['low', 'medium', 'high']

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

export type PrinterStateFilter = PrinterViewStateFilter

export type PrinterControlCommand = Extract<
  PrinterCommand,
  {
    type:
      | 'light'
      | 'setAirductMode'
      | 'setNozzleTemperature'
      | 'setBedTemperature'
      | 'setChamberTemperature'
      | 'setFanSpeed'
      | 'setPrintSpeed'
      | 'moveAxis'
      | 'homeAxes'
      | 'extrudeFilament'
  }
>

export function moveListItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex) return items
  const next = items.slice()
  const [moved] = next.splice(fromIndex, 1)
  if (moved === undefined) return items
  next.splice(toIndex, 0, moved)
  return next
}

export function parseHistoryViewMode(raw: string): DirectoryViewMode | null {
  return raw === 'list' || raw === 'icon' ? raw : null
}

export function formatHistoryResultsSummary(results: ReadonlyArray<PrintJob['result']>): string {
  if (results.length === 0) return 'No results'
  if (results.length === HISTORY_RESULTS.length) return 'All results'
  if (results.length === 1) return results[0] ?? '1 result'
  return `${results.length} results`
}

export function formatPrinterViewSelectValue(
  activePrinterViewId: string | null,
  printerViews: readonly PrinterView[],
  defaultPrinterViewId: string | null,
  isOverviewDefaultView: boolean
): string {
  if (!activePrinterViewId) {
    return isOverviewDefaultView ? `${OVERVIEW_VIEW_LABEL} (Default)` : OVERVIEW_VIEW_LABEL
  }

  const view = printerViews.find((entry) => entry.id === activePrinterViewId)
  if (!view) return OVERVIEW_VIEW_LABEL
  return defaultPrinterViewId === view.id ? `${view.name} (Default)` : view.name
}

export function parseCardsPerRow(raw: string): number | null {
  const parsed = Number(raw)
  return CARDS_PER_ROW_OPTIONS.includes(parsed as (typeof CARDS_PER_ROW_OPTIONS)[number]) ? parsed : null
}

export function parsePrinterStateFilter(raw: string): PrinterStateFilter | null {
  return PRINTER_STATE_FILTER_OPTIONS.includes(raw as PrinterStateFilter)
    ? (raw as PrinterStateFilter)
    : null
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

export function updateViewCardContentSetting(
  setFormValues: Dispatch<SetStateAction<PrinterViewInput>>,
  key: keyof PrinterCardContentSettings,
  value: boolean
): void {
  setFormValues((current) => ({
    ...current,
    cardContentSettings: {
      ...current.cardContentSettings,
      [key]: value
    }
  }))
}

export function togglePrinterSelection(printerIds: readonly string[], printerId: string): string[] {
  return printerIds.includes(printerId)
    ? printerIds.filter((entry) => entry !== printerId)
    : [...printerIds, printerId]
}

/**
 * Build the option lists for the printer-view attribute filters. Each list is
 * the union of values that make sense to offer (those present on configured
 * printers plus the common defaults) and any value already selected, so a saved
 * filter referencing a now-absent printer still renders as a checked option.
 */
export function buildPrinterModelFilterOptions(printers: Printer[], selected: readonly PrinterModel[]): PrinterModel[] {
  const models = new Set<PrinterModel>()
  for (const printer of printers) {
    if (printer.model !== 'unknown') models.add(printer.model)
  }
  for (const model of selected) models.add(model)
  return Array.from(models).sort((left, right) => left.localeCompare(right))
}

export function buildNozzleDiameterFilterOptions(selected: readonly string[]): string[] {
  const diameters = new Set<string>(NOZZLE_DIAMETER_OPTIONS)
  for (const value of selected) {
    const normalized = normalizeNozzleDiameter(value)
    if (normalized) diameters.add(normalized)
  }
  return Array.from(diameters).sort((left, right) => Number.parseFloat(left) - Number.parseFloat(right))
}

export function buildPlateTypeFilterOptions(printers: Printer[], selected: readonly string[]): string[] {
  const plateTypes = new Set<string>(COMMON_PLATE_TYPES)
  for (const printer of printers) {
    const normalized = normalizePlateType(printer.currentPlateType)
    if (normalized) plateTypes.add(normalized)
  }
  for (const value of selected) {
    const normalized = normalizePlateType(value)
    if (normalized) plateTypes.add(normalized)
  }
  return Array.from(plateTypes).sort((left, right) => left.localeCompare(right))
}

export function clonePrinterViewInput(input: PrinterViewInput): PrinterViewInput {
  return {
    name: input.name,
    printerIds: [...input.printerIds],
    cardsPerRow: input.cardsPerRow,
    stateFilter: input.stateFilter,
    modelFilter: [...input.modelFilter],
    nozzleDiameterFilter: [...input.nozzleDiameterFilter],
    plateTypeFilter: [...input.plateTypeFilter],
    sort: { ...input.sort },
    cardContentSettings: { ...input.cardContentSettings }
  }
}

export function resetPrinterViewInput(input: PrinterViewInput): PrinterViewInput {
  return {
    name: input.name,
    printerIds: [],
    cardsPerRow: 3,
    stateFilter: 'all',
    modelFilter: [],
    nozzleDiameterFilter: [],
    plateTypeFilter: [],
    sort: { ...defaultPrinterViewSort },
    cardContentSettings: { ...DEFAULT_PRINTER_CARD_CONTENT_SETTINGS }
  }
}

export function normalizePrinterViewInput(input: PrinterViewInput): PrinterViewInput {
  return {
    ...clonePrinterViewInput(input),
    name: input.name.trim()
  }
}

export function encodePrinterViewSort(sort: PrinterViewSort): string {
  return `${sort.key}:${sort.direction}`
}

export function decodePrinterViewSort(value: string): PrinterViewSort {
  const [key, direction] = value.split(':')
  const option = PRINTER_VIEW_SORT_OPTIONS.find((entry) => entry.value.key === key && entry.value.direction === direction)
  return option?.value ?? defaultPrinterViewSort
}

export function areNumberMapsEqual(left: Readonly<Record<string, number>>, right: Readonly<Record<string, number>>): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return rightKeys.every((key) => left[key] === right[key])
}

export function printerHistoryResultColor(result: PrintJob['result']): 'neutral' | 'success' | 'warning' | 'danger' {
  switch (result) {
    case 'success':
      return 'success'
    case 'failed':
      return 'danger'
    case 'cancelled':
      return 'warning'
    case 'unknown':
      return 'neutral'
  }
}

export function formatPrinterStatsWholeNumber(value: number): string {
  return new Intl.NumberFormat().format(value)
}

export function formatPrinterStatsDecimal(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
}

export function jobToLibraryFile(job: PrintJob): LibraryFile {
  return {
    id: job.fileId!,
    name: job.fileName ?? job.jobName,
    sizeBytes: job.fileSizeBytes ?? 0,
    uploadedAt: job.startedAt,
    kind: classifyLibraryFileKind(job.fileName ?? job.jobName),
    thumbnailPath: job.thumbnailPath,
    folderId: null,
    compatiblePrinterModels: [],
    plateTypeChips: [],
    nozzleSizeChips: [],
    projectFilamentChips: [],
    favorite: false,
    printCount: 0,
    lastPrintedAt: null
  }
}

export function printOptionSupportsSensitivity(option: PrinterPrintOptionKey): boolean {
  return option === 'aiMonitoring'
    || option === 'spaghettiDetection'
    || option === 'purgeChutePileupDetection'
    || option === 'nozzleClumpingDetection'
    || option === 'airPrintingDetection'
}

export function printOptionSensitivityOptions(option: PrinterPrintOptionKey): PrinterPrintOptionSensitivity[] {
  return option === 'aiMonitoring' ? AI_MONITORING_SENSITIVITY_OPTIONS : DETECTION_SENSITIVITY_OPTIONS
}

export function defaultPrintOptionSensitivity(_option: PrinterPrintOptionKey): PrinterPrintOptionSensitivity {
  return 'medium'
}

export function printOptionSensitivityLabel(value: PrinterPrintOptionSensitivity): string {
  switch (value) {
    case 'never_halt':
      return 'Never halt'
    case 'low':
      return 'Low'
    case 'medium':
      return 'Medium'
    case 'high':
      return 'High'
  }
}

export function dispatchStatusColor(status: PrintDispatchJob['status']): 'neutral' | 'primary' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'queued':
      return 'neutral'
    case 'uploading':
      return 'primary'
    case 'sent':
      return 'success'
    case 'cancelled':
      return 'warning'
    case 'failed':
      return 'danger'
  }
}

export function dispatchStatusLabel(status: PrintDispatchJob['status']): string {
  switch (status) {
    case 'queued':
      return 'Queued'
    case 'uploading':
      return 'Sending'
    case 'sent':
      return 'Sent'
    case 'cancelled':
      return 'Cancelled'
    case 'failed':
      return 'Failed'
  }
}

export function formatDispatchProgress(job: PrintDispatchJob): string {
  if (job.status === 'uploading' && job.uploadTotalBytes) {
    const percent = job.uploadPercent != null ? ` (${Math.round(job.uploadPercent)}%)` : ''
    const attempt = job.uploadAttempt > 1 && job.uploadMaxAttempts > 1 ? ` - attempt ${job.uploadAttempt} of ${job.uploadMaxAttempts}` : ''
    return `${formatBytes(job.uploadBytesSent)} of ${formatBytes(job.uploadTotalBytes)}${percent}${attempt}`
  }
  return `${job.progressMessage} - ${formatBytes(job.fileSizeBytes)}`
}

/** Convert a 0-based AMS unit id to its Bambu letter label (0 -> A, 1 -> B, ...). */
export function filamentPresetLabel(trayInfoIdx: string | null | undefined, fallbackMaterial: string | null, fallbackType: string | null | undefined): string | null {
  const presetName = trayInfoIdx ? BAMBU_FILAMENT_PRESET_NAMES[trayInfoIdx] : null
  if (presetName) return presetName
  if (fallbackMaterial) return `Bambu ${fallbackMaterial}`

  const filamentType = fallbackType?.trim() ?? ''
  return filamentType || null
}

/**
 * Plain-language label for the 1-5 humidity level reported by older AMS
 * units. Mirrors the descriptions Bambu Studio shows next to the dot icon.
 */
export function humidityLevelLabel(level: number): string {
  switch (level) {
    case 1: return 'Very dry'
    case 2: return 'Dry'
    case 3: return 'Fair'
    case 4: return 'Damp'
    case 5: return 'Wet'
    default: return 'Unknown'
  }
}

export function normalizeAmsDryingFilamentType(filamentType: string): string {
  const normalized = filamentType.trim().toUpperCase()
  const exact = AMS_DRYING_FILAMENT_TYPES.find((entry) => entry === normalized)
  if (exact) return exact

  const partial = AMS_DRYING_FILAMENT_TYPES.find((entry) => normalized.includes(entry))
  return partial ?? 'PLA'
}

export function dryingPresetForFilament(filamentType: string): {
  temperature: number
  durationHours: number
  coolingTemp: number
} {
  const normalized = filamentType.trim().toUpperCase()
  if (normalized.includes('TPU')) return { temperature: 65, durationHours: 12, coolingTemp: 40 }
  if (normalized.includes('PETG')) return { temperature: 65, durationHours: 8, coolingTemp: 50 }
  if (normalized.includes('ASA')) return { temperature: 75, durationHours: 8, coolingTemp: 60 }
  if (normalized.includes('ABS')) return { temperature: 75, durationHours: 8, coolingTemp: 60 }
  if (normalized.includes('PA') || normalized.includes('NYLON')) return { temperature: 80, durationHours: 12, coolingTemp: 65 }
  if (normalized.includes('PC')) return { temperature: 75, durationHours: 10, coolingTemp: 60 }
  if (normalized.includes('PVA')) return { temperature: 55, durationHours: 6, coolingTemp: 40 }
  return { temperature: 55, durationHours: 8, coolingTemp: 45 }
}

export function defaultAmsDryingProfile(unit: AmsUnit): {
  filamentType: string
  temperature: number
  durationHours: number
  rotateTray: boolean
} {
  const detectedType = normalizeAmsDryingFilamentType(unit.dryFilament
    ?? unit.slots.find((slot) => slot.filamentType && slot.filamentType.trim() !== '')?.filamentType
    ?? 'PLA')
  const preset = dryingPresetForFilament(detectedType)
  const hasActiveTemperature = unit.dryTemperature != null && unit.dryTemperature >= 30
  const hasActiveDuration = unit.dryDurationHours != null && unit.dryDurationHours >= 1
  return {
    filamentType: detectedType,
    temperature: hasActiveTemperature ? Math.round(unit.dryTemperature!) : preset.temperature,
    durationHours: hasActiveDuration ? unit.dryDurationHours! : preset.durationHours,
    rotateTray: true
  }
}

export function dryingCoolingTemperature(filamentType: string): number {
  return dryingPresetForFilament(filamentType).coolingTemp
}

export function formatAmsDryingPhaseLabel(unit: AmsUnit): string {
  switch (unit.dryingPhase) {
    case 'starting':
      return 'Starting'
    case 'drying':
      return 'Drying'
    case 'cooling':
      return 'Cooling down'
    case 'finishing':
      return 'Finishing'
    case 'unknown':
      return unit.dryingActive ? 'Drying active' : 'Idle'
    case 'idle':
    default:
      return unit.dryingActive ? 'Drying active' : 'Idle'
  }
}

export function formatAmsDryingPhaseDescription(unit: AmsUnit): string {
  switch (unit.dryingPhase) {
    case 'starting':
      return 'The AMS is warming up and preparing the drying cycle.'
    case 'drying':
      return 'The drying cycle is actively removing moisture from the loaded filament.'
    case 'cooling':
      return 'The AMS is cooling down before it returns to idle.'
    case 'finishing':
      return 'The drying cycle is wrapping up and the AMS will return to idle shortly.'
    case 'unknown':
      return 'The AMS reports an active drying cycle.'
    case 'idle':
    default:
      return 'The AMS is idle and ready for a new drying cycle.'
  }
}

export function formatPrinterCardNozzleSizes(
  status: PrinterStatus | undefined,
  savedSelections: readonly PrinterNozzleDiameterSelection[] | null | undefined
): string | null {
  const labels = Array.from(new Set(
    resolvePrinterNozzleDiameters(status, savedSelections)
      .map((selection) => formatNozzleDiameterLabel(selection.diameter))
      .filter((label): label is string => Boolean(label))
  ))

  if (labels.length === 0) return null
  if (labels.length === 1) return labels[0] ?? null
  return labels.join(' / ')
}

export function resolveFilamentChangeTargetTemp(
  source:
    | Pick<AmsSlot, 'trayInfoIdx' | 'filamentType'>
    | Pick<ExternalSpool, 'trayInfoIdx' | 'filamentType'>
    | null
    | undefined
): number | null {
  if (!source) return null
  const preset = (typeof source.trayInfoIdx === 'string' && source.trayInfoIdx.trim() !== '')
    ? BAMBU_FILAMENT_PRESETS.find((entry) => entry.id === source.trayInfoIdx)
    : filamentTypeDefaults(source.filamentType)

  if (preset?.tempMin == null || preset.tempMax == null) return null
  return Math.round((preset.tempMin + preset.tempMax) / 2)
}

export function formatHmsDisplayCode(code: string): string {
  const normalized = code.toUpperCase()
  if (/^[0-9A-F]{16}$/.test(normalized)) {
    return `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}`
  }
  if (/^[0-9A-F]{8}$/.test(normalized)) {
    return `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}`
  }
  return normalized
}

export function bambuHmsLanguageCode(): string {
  const raw = typeof navigator === 'object' && typeof navigator.language === 'string'
    ? navigator.language
    : 'en'
  const normalized = raw.toLowerCase().replace('_', '-')
  if (normalized.startsWith('zh')) return 'zh-cn'

  const short = normalized.slice(0, 2)
  switch (short) {
    case 'uk':
    case 'cs':
    case 'ru':
    case 'tr':
    case 'pt':
    case 'ko':
      return 'en'
    default:
      return short || 'en'
  }
}

export function compactHmsCode(code: string): string {
  return formatHmsDisplayCode(code).replace(/-/g, '').trim().toUpperCase()
}

export function hmsSupportSearchUrl(
  code: string,
  _message: string | null,
  _printerModel?: PrinterModel,
  printerSerial?: string
): string {
  const language = bambuHmsLanguageCode() === 'zh-cn' ? 'zh' : 'en'
  const baseUrl = `https://wiki.bambulab.com/${language}/hms/home`
  const displayCode = formatHmsDisplayCode(code).trim()

  const compactCode = compactHmsCode(code)
  if (/^[0-9A-F]{16}$/i.test(compactCode)) {
    const params = new URLSearchParams({
      e: compactCode,
      s: 'device_hms',
      lang: language
    })
    if (printerSerial?.trim()) {
      params.set('d', printerSerial.trim())
    }
    return `https://e.bambulab.com/index.php?${params.toString()}`
  }

  if (!displayCode) {
    return baseUrl
  }

  return `${baseUrl}#:~:text=${encodeURIComponent(displayCode)}`
}

export function hmsFallbackMessage(code: string): string {
  if (/^[0-9A-F]{8}$/i.test(code)) {
    return 'No Bambu description is available for this device error yet.'
  }
  if (/^[0-9A-F]{16}$/i.test(code)) {
    return 'No Bambu description is available for this HMS code yet.'
  }
  return 'No Bambu description is available for this printer error yet.'
}

export function formatPrinterAttentionSummaryText(summary: { code: string; message: string | null; count: number }): string {
  const codeLabel = formatHmsDisplayCode(summary.code)
  const message = summary.message ?? hmsFallbackMessage(summary.code)
  if (summary.count > 1) {
    return `${message} (${codeLabel}, +${summary.count - 1} more)`
  }
  return `${message} (${codeLabel})`
}

export function formatFilamentRecoverySourceDetail(source: Pick<AmsSlot | ExternalSpool, 'filamentType' | 'trayInfoIdx' | 'trayName'>): string {
  const parts: string[] = []
  const filamentType = source.filamentType?.trim() ?? ''

  if (filamentType !== '') {
    parts.push(resolveCompactFilamentTypeLabel(filamentType) ?? filamentType)
  } else if (source.trayInfoIdx && source.trayInfoIdx.trim() !== '') {
    parts.push('Configured filament')
  } else {
    parts.push('Configured source')
  }

  if (
    source.trayName
    && source.trayName.trim() !== ''
    && !isRawTrayCode(source.trayName)
    && source.trayName !== source.filamentType
  ) {
    parts.push(source.trayName)
  }

  return parts.join(' · ')
}

export function formatRemaining(minutes: number): string {
  return formatMinutesDuration(minutes)
}

/**
 * "how long ago a print finished" label for the history footer, mirroring the compact
 * duration format used for remaining time. Returns null when the timestamp is missing or
 * unparseable; "just now" for sub-minute elapsed times.
 */
export function formatFinishedAgo(finishedAt: string | null | undefined): string | null {
  if (!finishedAt) return null
  const finishedAtMs = Date.parse(finishedAt)
  if (Number.isNaN(finishedAtMs)) return null
  const minutes = Math.max(0, Math.round((Date.now() - finishedAtMs) / 60_000))
  return minutes < 1 ? 'just now' : `${formatMinutesDuration(minutes)} ago`
}

export function formatLayerSummary(status: Pick<PrinterStatus, 'currentLayer' | 'totalLayers'>): string {
  return `${status.currentLayer ?? 0} / ${status.totalLayers ?? 0}`
}

export function formatEstimatedCompletionTime(minutes: number): string {
  return formatEtaFromNow(minutes)
}

export function formatWifiSignal(signalDbm: number | null | undefined): string {
  if (signalDbm == null) return 'unavailable'
  return `${Math.round(signalDbm)} dBm`
}

export function formatDuctMode(mode: NonNullable<PrinterStatus['ductMode']>): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1)
}

export function lightNodeLabel(node: 'work' | PrinterControllableLightNode): string {
  switch (node) {
    case 'chamber':
      return 'Chamber light'
    case 'heatbed':
      return 'Heatbed light'
    case 'work':
      return 'Work light'
  }
}

export function isActiveLightMode(mode: PrinterLightMode | null | undefined): boolean {
  return mode === 'on' || mode === 'flashing'
}

export function formatLightMode(mode: PrinterLightMode | null | undefined): string {
  switch (mode) {
    case 'on':
      return 'Currently on'
    case 'off':
      return 'Currently off'
    case 'flashing':
      return 'Currently flashing'
    case 'unknown':
      return 'State unavailable'
    default:
      return 'Not reported'
  }
}

export function lightModeForControl(status: PrinterStatus, node: PrinterControllableLightNode): PrinterLightMode | null {
  if (node === 'chamber') {
    return status.lightModes.chamber ?? (status.lightOn == null ? null : status.lightOn ? 'on' : 'off')
  }
  return status.lightModes[node]
}

/**
 * Human-readable stage label for the printer card header. Returns
 * `"Offline"` when no status frame is available, prefixes `"Offline · "`
 * to the stage when the printer is reachable but the MQTT bridge marks
 * it offline, and otherwise returns the capitalized stage name.
 */
export function formatStageLabel(status: PrinterStatus | undefined): string {
  if (!status) return 'Offline'
  if ((status.stage === 'preparing' || status.stage === 'heating') && status.jobName === 'Calibration') {
    return status.online ? 'Calibrating' : 'Offline · Calibrating'
  }
  const stage = status.stage === 'finished' ? 'Idle' : capitalize(status.stage)
  return status.online ? stage : `Offline · ${stage}`
}

export function printerStateFilterLabel(filter: PrinterStateFilter): string {
  switch (filter) {
    case 'idle':
      return 'Idle'
    case 'printing':
      return 'Printing'
    case 'paused':
      return 'Paused'
    case 'error':
      return 'Error'
    case 'offline':
      return 'Offline'
    case 'all':
    default:
      return 'All states'
  }
}

export function matchesPrinterStateFilter(
  status: PrinterStatus | undefined,
  filter: PrinterStateFilter
): boolean {
  if (filter === 'all') return true
  if (!status || !status.online) return filter === 'offline'

  switch (filter) {
    case 'idle':
      return status.stage === 'idle' || status.stage === 'finished'
    case 'printing':
      return status.stage === 'printing' || status.stage === 'preparing' || status.stage === 'heating'
    case 'paused':
      return status.stage === 'paused'
    case 'error':
      return status.stage === 'failed' || status.deviceError != null || status.hmsErrors.length > 0
    case 'offline':
      return false
    default:
      return true
  }
}

/**
 * Applies the optional attribute filters a printer view can layer on top of the
 * state filter. Each filter is a set of allowed values; an empty set is a no-op.
 * Nozzle diameters are resolved from live status merged with the printer's saved
 * selections so the filter still works while a printer is offline.
 */
export function matchesPrinterViewAttributeFilters(
  printer: Printer,
  status: PrinterStatus | undefined,
  filters: {
    modelFilter: readonly PrinterModel[]
    nozzleDiameterFilter: readonly string[]
    plateTypeFilter: readonly string[]
  }
): boolean {
  if (filters.modelFilter.length > 0 && !filters.modelFilter.includes(printer.model)) {
    return false
  }

  if (filters.nozzleDiameterFilter.length > 0) {
    const allowed = new Set(
      filters.nozzleDiameterFilter
        .map((value) => normalizeNozzleDiameter(value))
        .filter((value): value is string => value !== null)
    )
    const printerDiameters = resolvePrinterNozzleDiameters(status, printer.currentNozzleDiameters)
      .map((entry) => entry.diameter)
      .filter((value): value is string => value !== null)
    if (!printerDiameters.some((value) => allowed.has(value))) {
      return false
    }
  }

  if (filters.plateTypeFilter.length > 0) {
    const allowed = new Set(
      filters.plateTypeFilter
        .map((value) => normalizePlateType(value)?.toUpperCase())
        .filter((value): value is string => value != null)
    )
    const plateType = normalizePlateType(printer.currentPlateType)
    if (!plateType || !allowed.has(plateType.toUpperCase())) {
      return false
    }
  }

  return true
}

export function filterPrintersForView(printers: Printer[], printerIds: readonly string[]): Printer[] {
  if (printerIds.length === 0) return printers
  const allowed = new Set(printerIds)
  return printers.filter((printer) => allowed.has(printer.id))
}

export function sortPrintersForView(
  printers: Printer[],
  statuses: Record<string, PrinterStatus>,
  sort: PrinterViewSort
): Printer[] {
  if (sort.key === 'manual') return printers

  const direction = sort.direction === 'asc' ? 1 : -1
  return printers.slice().sort((left, right) => {
    let comparison = 0
    if (sort.key === 'name') {
      comparison = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
    } else if (sort.key === 'model') {
      comparison = left.model.localeCompare(right.model, undefined, { sensitivity: 'base' })
      if (comparison === 0) {
        comparison = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
      }
    } else if (sort.key === 'state') {
      comparison = printerStateSortRank(statuses[left.id]) - printerStateSortRank(statuses[right.id])
      if (comparison === 0) {
        comparison = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
      }
    }

    if (comparison !== 0) return comparison * direction
    return left.position - right.position
  })
}

export function printerStateSortRank(status: PrinterStatus | undefined): number {
  if (!status || !status.online) return 4
  if (status.stage === 'failed' || status.deviceError != null || status.hmsErrors.length > 0) return 3
  if (status.stage === 'paused') return 2
  if (status.stage === 'printing' || status.stage === 'preparing' || status.stage === 'heating') return 0
  return 1
}

export function capitalize(value: string): string {
  if (!value) return value
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export function speedLabel(level: number): string {
  switch (level) {
    case 1: return 'Silent'
    case 2: return 'Standard'
    case 3: return 'Sport'
    case 4: return 'Ludicrous'
    default: return String(level)
  }
}

export function isPrinterControlCommand(command: PrinterCommand): command is PrinterControlCommand {
  return (
    command.type === 'light' ||
    command.type === 'setAirductMode' ||
    command.type === 'setNozzleTemperature' ||
    command.type === 'setBedTemperature' ||
    command.type === 'setChamberTemperature' ||
    command.type === 'setFanSpeed' ||
    command.type === 'setPrintSpeed' ||
    command.type === 'moveAxis' ||
    command.type === 'homeAxes' ||
    command.type === 'extrudeFilament'
  )
}

export function printerControlSuccessMessage(command: PrinterControlCommand): string {
  switch (command.type) {
    case 'light':
      return `${lightNodeLabel(command.node)} ${command.on ? 'turned on' : 'turned off'}`
    case 'setAirductMode':
      return `Air management set to ${formatDuctMode(command.mode)}`
    case 'setNozzleTemperature':
      return command.target > 0 ? `Nozzle target set to ${command.target}°C` : 'Nozzle heater turned off'
    case 'setBedTemperature':
      return 'Bed temperature updated'
    case 'setChamberTemperature':
      return 'Chamber temperature updated'
    case 'setFanSpeed':
      return `${fanControlLabel(command.fan)} updated`
    case 'setPrintSpeed':
      return 'Print speed updated'
    case 'moveAxis':
      return `${command.axis}-axis move requested`
    case 'homeAxes':
      return 'Homing requested'
    case 'extrudeFilament':
      return command.distanceMm > 0 ? 'Extrusion requested' : 'Retraction requested'
  }
}

export function suggestedTemperatureInput(current: number | null, target: number | null): string {
  if (target != null && target > 0) return String(Math.round(target))
  if (current != null && current > 0) return String(Math.round(current))
  return ''
}

export function suggestedPercentInput(value: number | null): string {
  return value != null ? String(Math.round(value)) : ''
}

export function parseIntegerInput(value: string, min: number, max: number): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null
  return parsed
}

export function formatTemperatureValue(value: number | null): string {
  return value != null ? `${Math.round(value)}°` : '—'
}

export function formatPercentValue(value: number | null): string {
  return value != null ? `${Math.round(value)}%` : '—'
}

export function fanControlLabel(fan: PrinterFanId): string {
  switch (fan) {
    case 'part':
      return 'Part fan'
    case 'aux':
      return 'Aux fan'
    case 'chamber':
      return 'Chamber fan'
  }
}

/** Coerce a possibly 8-char `#RRGGBBAA` string to the 7-char `#RRGGBB` form HTML color inputs require. */
export function normalizeHex(value: string): string {
  const hex = value.replace('#', '').slice(0, 6)
  if (!/^[0-9a-fA-F]+$/.test(hex)) return '#000000'
  return `#${hex.padStart(6, '0')}`
}

export function formatLocalUploadPhase(phase: ChunkedLibraryUploadPhase): string {
  switch (phase) {
    case 'sending-to-bridge':
      return 'Sending to bridge'
    case 'finalizing':
      return 'Finalizing'
    case 'waiting-for-server':
      return 'Waiting for server (rate limited)'
    case 'uploading-to-server':
    default:
      return 'Uploading to server'
  }
}

export function collectDistinctLibraryFilterValues(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right))
}

export function shouldPreferTrackedActiveJobName(liveJobName: string | null, trackedJobName: string | null): boolean {
  if (!liveJobName || !trackedJobName || liveJobName === trackedJobName) return false
  const splitIndex = liveJobName.lastIndexOf(' - ')
  const livePlateLabel = splitIndex > 0 ? liveJobName.slice(splitIndex + 3).trim() : liveJobName.trim()
  return normalizeFallbackPlateLabel(livePlateLabel) !== livePlateLabel
}

export function externalSpoolLabel(amsId: ExternalSpool['amsId'], spoolCount: number): string {
  if (spoolCount > 1) {
    return amsId === 255 ? 'Ext-R' : 'Ext-L'
  }
  return 'Ext'
}

export function printerCardAmsGridColumns(cardsPerRow: number): number {
  if (cardsPerRow === 1) return 8
  if (cardsPerRow === 2) return 4
  return 4
}

export function amsUnitSlotSpan(unit: AmsUnit): number {
  return Math.max(1, Math.min(4, unit.slots.length))
}

export function parseStoredBoolean(raw: string): boolean | null {
  if (raw === 'true') return true
  if (raw === 'false') return false
  return null
}

export function parseStoredOptionalString(raw: string): string | null {
  const value = raw.trim()
  return value && value !== 'null' ? value : null
}

export function serializeStoredOptionalString(value: string | null): string {
  return value ?? ''
}

export function parseStoredStringArray(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
  } catch {
    return null
  }
}

export function parsePrinterModelFilter(raw: string): PrinterModel[] | null {
  try {
    const result = printerViewModelFilterSchema.safeParse(JSON.parse(raw) as unknown)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

export function parsePrinterViewSort(raw: string): PrinterViewSort | null {
  if (!raw) return null
  return decodePrinterViewSort(raw)
}

export function parsePrinterCardContentSettings(raw: string): PrinterCardContentSettings | null {
  try {
    const result = printerCardContentSettingsSchema.safeParse(JSON.parse(raw) as unknown)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

export function printerNozzles(status: PrinterStatus | undefined): PrinterStatus['nozzles'] {
  if (!status) return []
  if (status.nozzles.length > 0) return status.nozzles
  if (status.nozzleTemp == null && status.nozzleTarget == null) return []
  return [{ extruderId: 0, diameter: null, typeCode: null, material: null, flow: null, currentTemp: status.nozzleTemp, targetTemp: status.nozzleTarget }]
}

export function formatNozzleMaterial(material: PrinterStatus['nozzles'][number]['material']): string | null {
  switch (material) {
    case 'stainless-steel':
      return 'Stainless steel'
    case 'hardened-steel':
      return 'Hardened steel'
    case 'tungsten-carbide':
      return 'Tungsten carbide'
    default:
      return null
  }
}

export function formatNozzleFlow(flow: PrinterStatus['nozzles'][number]['flow']): string | null {
  switch (flow) {
    case 'standard':
      return 'Standard flow'
    case 'high':
      return 'High flow'
    case 'tpu-high':
      return 'TPU high flow'
    default:
      return null
  }
}

export function formatNozzleHardwareSummary(nozzle: PrinterStatus['nozzles'][number]): string | null {
  const parts: string[] = []
  const diameterLabel = formatNozzleDiameterLabel(nozzle.diameter)
  if (diameterLabel) parts.push(diameterLabel)

  const materialLabel = formatNozzleMaterial(nozzle.material)
  if (materialLabel) parts.push(materialLabel)

  const flowLabel = formatNozzleFlow(nozzle.flow)
  if (flowLabel) parts.push(flowLabel)

  if (parts.length === 0 && nozzle.typeCode) parts.push(nozzle.typeCode)
  return parts.length > 0 ? parts.join(' · ') : null
}
