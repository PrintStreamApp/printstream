/**
 * Shared print-start dialog defaults, recorded-job restoration, and capability clamping.
 * Fresh dialogs always start from PrintStream's defaults; only an explicit re-print restores
 * choices captured on that job.
 */
import type {
  PrintNozzleOffsetCalibrationMode,
  PrintOnOffAutoMode,
  PrintStartOptionSelection,
  PrinterPrintStartOptions
} from '@printstream/shared'

export interface PrintStartDialogOptions {
  bedLevel: PrintOnOffAutoMode
  vibrationCompensation: boolean
  flowCalibration: PrintOnOffAutoMode
  timelapse: boolean
  timelapseStorage: PrintStartOptionSelection['timelapseStorage']
  externalFilamentChangeAssist: boolean
  nozzleOffsetCalibration: PrintNozzleOffsetCalibrationMode
}

export const DEFAULT_PRINT_START_OPTIONS: PrintStartDialogOptions = {
  bedLevel: 'auto',
  vibrationCompensation: false,
  flowCalibration: 'auto',
  timelapse: false,
  timelapseStorage: 'external',
  externalFilamentChangeAssist: false,
  nozzleOffsetCalibration: 'auto'
}

export function mergePrintStartOptions(options: PrinterPrintStartOptions[]): PrinterPrintStartOptions {
  if (options.length === 0) {
    return {
      bedLevel: { supported: true, autoSupported: false, current: null },
      vibrationCompensation: { supported: false, current: null },
      flowCalibration: { supported: false, autoSupported: false, current: null },
      firstLayerInspection: { supported: false, current: null },
      timelapse: { supported: false, current: null },
      internalTimelapseStorage: { supported: false, current: null },
      externalFilamentChangeAssist: { supported: false, current: null },
      filamentDynamicsCalibration: { supported: false, current: null },
      nozzleOffsetCalibration: { supported: false, current: null }
    }
  }

  return {
    bedLevel: {
      supported: options.some((option) => option.bedLevel.supported),
      autoSupported: options.some((option) => option.bedLevel.autoSupported),
      current: resolveSharedValue(options.map((option) => option.bedLevel.current))
    },
    vibrationCompensation: {
      supported: false,
      current: null
    },
    flowCalibration: {
      supported: options.some((option) => option.flowCalibration.supported),
      autoSupported: options.some((option) => option.flowCalibration.autoSupported),
      current: resolveSharedValue(options.map((option) => option.flowCalibration.current))
    },
    firstLayerInspection: {
      supported: options.some((option) => option.firstLayerInspection.supported),
      current: resolveSharedValue(options.map((option) => option.firstLayerInspection.current))
    },
    timelapse: {
      supported: options.some((option) => option.timelapse.supported),
      current: resolveSharedValue(options.map((option) => option.timelapse.current))
    },
    internalTimelapseStorage: {
      supported: options.some((option) => option.internalTimelapseStorage.supported),
      current: resolveSharedValue(options.map((option) => option.internalTimelapseStorage.current))
    },
    externalFilamentChangeAssist: {
      supported: options.some((option) => option.externalFilamentChangeAssist.supported),
      current: resolveSharedValue(options.map((option) => option.externalFilamentChangeAssist.current))
    },
    filamentDynamicsCalibration: {
      supported: options.some((option) => option.filamentDynamicsCalibration.supported),
      current: resolveSharedValue(options.map((option) => option.filamentDynamicsCalibration.current))
    },
    nozzleOffsetCalibration: {
      supported: options.some((option) => option.nozzleOffsetCalibration.supported),
      current: resolveSharedValue(options.map((option) => option.nozzleOffsetCalibration.current))
    }
  }
}

/**
 * Layer the options a specific print was started with over PrintStream's fresh-print defaults.
 *
 * Per field, not all-or-nothing: `recorded` is what a `PrintJob` actually captured, and a
 * field it never captured is absent rather than defaulted (see `PrintJob.printOptions`).
 * Absent falls through to the normal default, so legacy jobs behave like fresh prints while
 * recent jobs restore their captured choices.
 *
 * `firstLayerInspection` / `filamentDynamicsCalibration` are ignored: the print dialog does
 * not offer them (it derives both at submit time), so there is no control to restore them to.
 */
export function applyRecordedPrintStartOptions(
  defaults: PrintStartDialogOptions,
  recorded: Partial<PrintStartOptionSelection> | null | undefined
): PrintStartDialogOptions {
  if (!recorded) return { ...defaults, vibrationCompensation: false }
  return {
    bedLevel: recorded.bedLevel ?? defaults.bedLevel,
    vibrationCompensation: false,
    flowCalibration: recorded.flowCalibration ?? defaults.flowCalibration,
    timelapse: recorded.timelapse ?? defaults.timelapse,
    timelapseStorage: recorded.timelapseStorage ?? defaults.timelapseStorage,
    externalFilamentChangeAssist:
      recorded.externalFilamentChangeAssist ?? defaults.externalFilamentChangeAssist,
    nozzleOffsetCalibration: recorded.nozzleOffsetCalibration ?? defaults.nozzleOffsetCalibration
  }
}

/**
 * Adapts dialog defaults to what the selected printer(s) actually support so an `auto` restored
 * from an H2D job does not render as a blank dropdown on a printer that lacks that option (e.g.
 * a P1S). Falls back to `on`, matching the submit-time normalization in
 * the print dialog, so the displayed value equals what would be dispatched.
 */
export function resolvePrintStartDefaults(
  defaults: PrintStartDialogOptions,
  printStartOptions?: PrinterPrintStartOptions | null
): PrintStartDialogOptions {
  if (!printStartOptions) return defaults
  const bedLevel: PrintOnOffAutoMode = defaults.bedLevel === 'auto' && !printStartOptions.bedLevel.autoSupported
    ? 'on'
    : defaults.bedLevel
  const flowCalibration: PrintOnOffAutoMode = defaults.flowCalibration === 'auto' && !printStartOptions.flowCalibration.autoSupported
    ? 'on'
    : defaults.flowCalibration
  if (bedLevel === defaults.bedLevel && flowCalibration === defaults.flowCalibration) {
    return defaults
  }
  return { ...defaults, bedLevel, flowCalibration }
}

/**
 * Whether every visible tri-state selection exists in the target's option list.
 * Unsupported fields are omitted and normalized by dispatch, so only a visible Auto choice on
 * an On/Off-only target is invalid. Dialogs use this during capability transitions to prevent a
 * stale selection from being submitted while React is applying the resolved defaults.
 */
export function arePrintStartModesAvailable(
  selection: Pick<PrintStartDialogOptions, 'bedLevel' | 'flowCalibration'>,
  printStartOptions?: PrinterPrintStartOptions | null
): boolean {
  if (!printStartOptions) return true
  const bedLevelAvailable = !printStartOptions.bedLevel.supported
    || selection.bedLevel !== 'auto'
    || printStartOptions.bedLevel.autoSupported
  const flowCalibrationAvailable = !printStartOptions.flowCalibration.supported
    || selection.flowCalibration !== 'auto'
    || printStartOptions.flowCalibration.autoSupported
  return bedLevelAvailable && flowCalibrationAvailable
}

export function resolveFirstLayerInspectionDefault(
  printStartOptions: PrinterPrintStartOptions | null | undefined
): boolean {
  if (!printStartOptions?.firstLayerInspection.supported) return false
  return printStartOptions.firstLayerInspection.current ?? true
}

function resolveSharedValue<T>(values: Array<T | null>): T | null {
  const knownValues = values.filter((value): value is T => value != null)
  if (knownValues.length === 0) return null
  const first = knownValues[0] as T
  return knownValues.every((value) => value === first) ? first : null
}
