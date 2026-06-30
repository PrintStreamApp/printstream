/**
 * Per-(item, printer) readiness breakdown for the print queue: how well one printer matches a queued
 * item across the dimensions that decide whether it can run now — sliced-for **model**, **nozzle**
 * diameter, **plate** type, and loaded **material**. Used by the start dialog to rank printers
 * most-ready-first and show per-aspect chips, and by the queue card to show fleet-level match chips.
 * Material is overridable (the start dialog lets the user pick slots) and the plate can be swapped /
 * the mismatch overridden at print time; model/nozzle are hardware constraints. Plate matches the
 * printer's manually-set `currentPlateType`.
 */
import {
  evaluateQueueMatch,
  getDetectedPrinterNozzleDiameters,
  isPlateTypeCompatible,
  isPrinterActiveJobStage,
  isPrinterModelCompatible,
  loadedSlotsFromStatus,
  normalizePlateType,
  type Printer,
  type PrinterModel,
  type PrinterStatus,
  type QueueItem
} from '@printstream/shared'

/** `match`/`mismatch` are definite; `unknown` = constrained but undeterminable (e.g. printer hides its nozzle); `na` = the item imposes no such constraint. */
export type AspectState = 'match' | 'mismatch' | 'unknown' | 'na'

export interface PrinterAspectMatch {
  printerId: string
  online: boolean
  idle: boolean
  model: AspectState
  nozzle: AspectState
  plate: AspectState
  material: AspectState
  /** Display values for the chips (this printer's actual model / nozzle / plate, and loaded-vs-needed
   *  material count) — `null` when the item imposes no such constraint. */
  modelLabel: string
  nozzleLabel: string | null
  plateLabel: string | null
  materialLabel: string | null
  /** Sort key — higher is more ready (fewer overrides needed). */
  score: number
}

function normalizeDiameter(value: string): string {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? String(parsed) : value.trim()
}

/** This printer's detected nozzle diameters (normalized, e.g. ["0.4"]). */
function printerNozzleDiameters(status: PrinterStatus | undefined): string[] {
  return getDetectedPrinterNozzleDiameters(status)
    .map((nozzle) => nozzle.diameter)
    .filter((diameter): diameter is string => diameter != null)
    .map(normalizeDiameter)
}

function nozzleState(item: QueueItem, have: string[]): AspectState {
  if (item.nozzleDiameters.length === 0) return 'na'
  if (have.length === 0) return 'unknown'
  const haveSet = new Set(have)
  return item.nozzleDiameters.map(normalizeDiameter).every((diameter) => haveSet.has(diameter)) ? 'match' : 'mismatch'
}

/** Match the file's sliced-for plate against the printer's manually-set `currentPlateType`. */
function plateState(item: QueueItem, printer: Printer): AspectState {
  if (!normalizePlateType(item.plateType)) return 'na'
  if (!normalizePlateType(printer.currentPlateType)) return 'unknown'
  return isPlateTypeCompatible(item.plateType, printer.currentPlateType) ? 'match' : 'mismatch'
}

/** Score one aspect: a satisfied (matched, or not constrained) aspect helps; an unknown one helps a little. */
function aspectScore(state: AspectState, weight: number): number {
  if (state === 'match' || state === 'na') return weight
  if (state === 'unknown') return weight * 0.5
  return 0
}

export function matchPrinterAspects(
  item: QueueItem,
  printer: Printer,
  status: PrinterStatus | undefined,
  allowTypeOnlyMatch: boolean
): PrinterAspectMatch {
  const online = status?.online ?? false
  const idle = status?.online ? !isPrinterActiveJobStage(status.stage) : false
  const model: AspectState = item.compatibleModels.length === 0
    ? 'na'
    : isPrinterModelCompatible(item.compatibleModels as PrinterModel[], printer.model as PrinterModel) ? 'match' : 'mismatch'
  const nozzles = printerNozzleDiameters(status)
  const nozzle = nozzleState(item, nozzles)
  const plate = plateState(item, printer)
  const matchResult = status && item.requiredFilaments.length > 0
    ? evaluateQueueMatch(item.requiredFilaments, loadedSlotsFromStatus(status), { allowTypeOnlyMatch })
    : null
  const material: AspectState = item.requiredFilaments.length === 0 ? 'na' : matchResult?.matched ? 'match' : 'mismatch'

  // Chip values show what THIS printer actually has (falling back to the requirement when the printer
  // doesn't report it), so the chips read e.g. "X1C", "0.4 mm", "Textured PEI", "1/2".
  const requiredNozzles = item.nozzleDiameters.map(normalizeDiameter)
  const nozzleLabel = item.nozzleDiameters.length === 0
    ? null
    : `${(nozzles.length > 0 ? nozzles : requiredNozzles).join('/')} mm`
  const plateLabel = normalizePlateType(printer.currentPlateType) ?? normalizePlateType(item.plateType)
  const materialLabel = item.requiredFilaments.length === 0
    ? null
    : `${item.requiredFilaments.length - (matchResult?.missing.length ?? item.requiredFilaments.length)}/${item.requiredFilaments.length}`

  // Material is weighted highest: it's the usual blocker, and a printer that already has it needs no
  // override. Plate is the softest (swappable / overridable at print). The idle bonus keeps a ready idle
  // printer ahead of an equally-matched busy one.
  const score = aspectScore(material, 4) + aspectScore(model, 2) + aspectScore(nozzle, 2) + aspectScore(plate, 1) + (idle ? 1 : 0)
  return {
    printerId: printer.id,
    online,
    idle,
    model,
    nozzle,
    plate,
    material,
    modelLabel: printer.model,
    nozzleLabel,
    plateLabel,
    materialLabel,
    score
  }
}

/** Whether any of the given printers satisfies an aspect — for the card's fleet-level chips. */
export function fleetAspectState(matches: PrinterAspectMatch[], aspect: 'model' | 'nozzle' | 'plate' | 'material'): AspectState {
  if (matches.length === 0) return 'unknown'
  if (matches.every((match) => match[aspect] === 'na')) return 'na'
  if (matches.some((match) => match[aspect] === 'match')) return 'match'
  if (matches.some((match) => match[aspect] === 'unknown')) return 'unknown'
  return 'mismatch'
}
