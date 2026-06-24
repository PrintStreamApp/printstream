/**
 * Derives the human-readable progress detail shown for a printer: maps Bambu
 * sub-stage codes/text to labels, decides when that secondary stage should be
 * preferred over the primary stage (e.g. during preparation/heating), summarizes
 * device/HMS errors needing attention, and detects when a pending dispatched
 * print has actually started so the optimistic placeholder can be cleared.
 */
import { isPrinterActiveJobStage, isPrinterIdleCompatibleStage, type PrinterStatus } from '@printstream/shared'

type ProgressSummaryStatus = Pick<PrinterStatus, 'stage' | 'currentLayer' | 'remainingMinutes'>
type SecondaryStageStatus = Pick<PrinterStatus, 'stage' | 'subStage'>
type LiveSecondaryStageSummaryStatus = Pick<PrinterStatus, 'online' | 'stage' | 'currentLayer' | 'remainingMinutes'>
type PendingDispatchStatus = Pick<PrinterStatus, 'online' | 'stage' | 'progressPercent' | 'subStage'>
type AttentionSummaryStatus = Pick<PrinterStatus, 'deviceError' | 'hmsErrors'>

export interface PrinterAttentionSummary {
  kind: 'deviceError' | 'hmsError'
  code: string
  message: string | null
  count: number
}

const BAMBU_STUDIO_SUB_STAGE_LABELS: Record<number, string> = {
  1: 'Auto bed leveling',
  2: 'Heatbed preheating',
  3: 'Vibration compensation',
  4: 'Changing filament',
  5: 'M400 pause',
  6: 'Paused (filament ran out)',
  7: 'Heating nozzle',
  8: 'Calibrating dynamic flow',
  9: 'Scanning bed surface',
  10: 'Inspecting first layer',
  11: 'Identifying build plate type',
  12: 'Calibrating Micro Lidar',
  13: 'Homing toolhead',
  14: 'Cleaning nozzle tip',
  15: 'Checking extruder temperature',
  16: 'Paused by the user',
  17: 'Pause (front cover fall off)',
  18: 'Calibrating the micro lidar',
  19: 'Calibrating flow ratio',
  20: 'Pause (nozzle temperature malfunction)',
  21: 'Pause (heatbed temperature malfunction)',
  22: 'Filament unloading',
  23: 'Pause (step loss)',
  24: 'Filament loading',
  25: 'Motor noise cancellation',
  26: 'Pause (AMS offline)',
  27: 'Pause (low speed of the heatbreak fan)',
  28: 'Pause (chamber temperature control problem)',
  29: 'Cooling chamber',
  30: 'Pause (Gcode inserted by user)',
  31: 'Motor noise showoff',
  32: 'Pause (nozzle clumping)',
  33: 'Pause (cutter error)',
  34: 'Pause (first layer error)',
  35: 'Pause (nozzle clog)',
  36: 'Measuring motion percision',
  37: 'Enhancing motion percision',
  38: 'Measure motion accuracy',
  39: 'Nozzle offset calibration',
  40: 'high temperature auto bed levelling',
  41: 'Auto Check: Quick Release Lever',
  42: 'Auto Check: Door and Upper Cover',
  43: 'Laser Calibration',
  44: 'Auto Check: Platform',
  45: 'Confirming BirdsEye Camera location',
  46: 'Calibrating BirdsEye Camera',
  47: 'Auto bed leveling -phase 1',
  48: 'Auto bed leveling -phase 2',
  49: 'Heating chamber',
  50: 'Adjusting heatbed temperature',
  51: 'Printing calibration lines',
  52: 'Auto Check: Material',
  53: 'Live View Camera Calibration',
  54: 'Waiting for heatbed to reach target temperature',
  55: 'Auto Check: Material Position',
  56: 'Cutting Module Offset Calibration',
  57: 'Measuring Surface',
  58: 'Thermal Preconditioning for first layer optimization',
  59: 'Homing Blade Holder',
  60: 'Calibrating Camera Offset',
  61: 'Calibrating Blade Holder Position',
  62: 'Hotend Pick and Place Test',
  63: 'Waiting for the Chamber temperature to equalize',
  64: 'Preparing Hotend',
  65: 'Calibrating the detection position of nozzle clumping',
  66: 'Purifying the chamber air',
  67: 'Measuring Rotary Attachment',
  68: 'The toolhead moves above the purge chute',
  69: 'Cooling down the nozzle',
  70: 'The toolhead moves to the center of the heatbed',
  71: 'Active Arc Fitting',
  72: 'Hotend Type Detection',
  73: 'Build plate alignment detection',
  74: 'Heatbed surface foreign object detection',
  75: 'Heatbed underside foreign object detection',
  76: 'Pre-extrusion before printing',
  77: 'Preparing AMS'
}

const PREPARATION_STAGE_LABEL_PATTERN = /\b(auto bed leveling|bed levelling|calibrat(?:e|ing|ion)|preheat(?:ing)?|heat(?:ing)?(?: nozzle| chamber| bed| heatbed)?|scann(?:ing)?|inspect(?:ing)?|identif(?:y|ying)|hom(?:e|ing)|clean(?:ing)?|check(?:ing)?|wait(?:ing)?|prepar(?:e|ing)|measur(?:e|ing)|cool(?:ing)? chamber|chang(?:e|ing) filament|filament (?:load|unload)(?:ing)?|motor noise|thermal preconditioning|pre extrusion|pre-extrusion|foreign object detection|build plate alignment|nozzle offset|purifying the chamber air|preparing ams)\b/i
const LAYER_SUB_STAGE_PATTERN = /^layer\s+\d+\s*\/\s*\d+$/i

function normalizeStageComparison(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9() ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatStageText(raw: string): string {
  const normalized = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return ''

  return normalized.replace(/\b\w+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
}

export function formatSecondaryStageLabel(status: SecondaryStageStatus | undefined): string | null {
  const raw = status?.subStage?.trim()
  if (!status || !raw) return null
  if (LAYER_SUB_STAGE_PATTERN.test(raw)) return null

  const numericCode = /^-?\d+$/.test(raw) ? Number(raw) : null
  const label = numericCode != null
    ? BAMBU_STUDIO_SUB_STAGE_LABELS[numericCode] ?? ''
    : formatStageText(raw)

  if (!label) return null
  if (numericCode === 0 || numericCode === -1 || numericCode === 255) return null
  if (normalizeStageComparison(label) === normalizeStageComparison(status.stage)) return null

  return label
}

export function shouldPreferSecondaryStageLabel(
  status: ProgressSummaryStatus | undefined,
  secondaryStageLabel: string | null
): boolean {
  if (!status || !secondaryStageLabel) {
    return false
  }

  if (status.stage === 'preparing' || status.stage === 'heating') {
    return true
  }

  if (PREPARATION_STAGE_LABEL_PATTERN.test(secondaryStageLabel)) {
    return true
  }

  if (status.remainingMinutes == null) {
    return false
  }

  if (!isPrinterActiveJobStage(status.stage)) {
    return false
  }

  return status.currentLayer == null || status.currentLayer <= 1
}

export function shouldShowLiveSecondaryStageSummary(
  status: LiveSecondaryStageSummaryStatus | undefined,
  secondaryStageLabel: string | null
): boolean {
  if (status?.online !== true || !secondaryStageLabel) {
    return false
  }

  return shouldPreferSecondaryStageLabel(status, secondaryStageLabel)
}

/**
 * @param options.includeHmsErrors When false, HMS alerts are omitted from the
 *   summary (the active view's "HMS errors" card toggle is off); a more serious
 *   device error still surfaces. Defaults to true.
 */
export function getPrinterAttentionSummary(
  status: AttentionSummaryStatus | undefined,
  options: { includeHmsErrors?: boolean } = {}
): PrinterAttentionSummary | null {
  if (status?.deviceError) {
    return {
      kind: 'deviceError',
      code: status.deviceError.code,
      message: status.deviceError.message,
      count: 1
    }
  }

  if (options.includeHmsErrors === false) {
    return null
  }

  const firstHmsError = status?.hmsErrors[0]
  if (!firstHmsError) {
    return null
  }

  return {
    kind: 'hmsError',
    code: firstHmsError.code,
    message: firstHmsError.message,
    count: status.hmsErrors.length
  }
}

export function shouldClearPendingDispatchedPrint(status: PendingDispatchStatus | undefined): boolean {
  if (!status?.online) {
    return false
  }

  if (status.progressPercent != null) {
    return true
  }

  if (!isPrinterIdleCompatibleStage(status.stage)) {
    return true
  }

  return formatSecondaryStageLabel(status) != null
}