/**
 * Shared print-start dialog defaults and remembered browser preferences.
 * Preferences are scoped by auth context and printer model set so one
 * user's choices do not leak across accounts or printer families.
 */
import type {
  AuthBootstrap,
  PrintNozzleOffsetCalibrationMode,
  PrintOnOffAutoMode,
  PrinterModel,
  PrinterPrintStartOptions
} from '@printstream/shared'
import { resolveAuthScope } from './authQuery'

export interface StoredPrintStartOptions {
  bedLevel: PrintOnOffAutoMode
  vibrationCompensation: boolean
  flowCalibration: PrintOnOffAutoMode
  timelapse: boolean
  nozzleOffsetCalibration: PrintNozzleOffsetCalibrationMode
}

export const DEFAULT_STORED_PRINT_START_OPTIONS: StoredPrintStartOptions = {
  bedLevel: 'auto',
  vibrationCompensation: true,
  flowCalibration: 'auto',
  timelapse: false,
  nozzleOffsetCalibration: 'auto'
}

export function parseStoredPrintStartOptions(raw: string): StoredPrintStartOptions | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredPrintStartOptions>
    const bedLevel = parseStoredPrintOnOffAutoMode(parsed.bedLevel)
    const flowCalibration = parseStoredPrintOnOffAutoMode(parsed.flowCalibration)
    const nozzleOffsetCalibration = parseStoredNozzleOffsetCalibrationMode(parsed.nozzleOffsetCalibration)
    if (!bedLevel || !flowCalibration || typeof parsed.timelapse !== 'boolean' || !nozzleOffsetCalibration) {
      return null
    }
    return {
      bedLevel,
      vibrationCompensation: typeof parsed.vibrationCompensation === 'boolean'
        ? parsed.vibrationCompensation
        : DEFAULT_STORED_PRINT_START_OPTIONS.vibrationCompensation,
      flowCalibration,
      timelapse: parsed.timelapse,
      nozzleOffsetCalibration
    }
  } catch {
    return null
  }
}

export function buildPrintStartPreferenceKey(
  authBootstrap: Pick<AuthBootstrap, 'actor' | 'tenant'> | null | undefined,
  printerModels: PrinterModel[]
): string {
  const { authScopeKey } = resolveAuthScope(authBootstrap)
  return `bambu.printStartOptions.v3.${authScopeKey}.${resolveActorScope(authBootstrap?.actor)}.${buildPrinterModelScope(printerModels)}`
}

export function mergePrintStartOptions(options: PrinterPrintStartOptions[]): PrinterPrintStartOptions {
  if (options.length === 0) {
    return {
      bedLevel: { supported: true, autoSupported: false, current: null },
      vibrationCompensation: { supported: false, current: null },
      flowCalibration: { supported: false, autoSupported: false, current: null },
      firstLayerInspection: { supported: false, current: null },
      timelapse: { supported: false, current: null },
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
      supported: options.some((option) => option.vibrationCompensation.supported),
      current: resolveSharedValue(options.map((option) => option.vibrationCompensation.current))
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
 * Adapts remembered preferences to what the selected printer(s) actually support so a stored
 * `auto` (e.g. from an H2D) does not render as a blank dropdown on a printer that lacks the
 * `auto` option (e.g. a P1S). Falls back to `on`, matching the submit-time normalization in
 * the print dialog, so the displayed value equals what would be dispatched.
 */
export function resolvePrintStartPreferenceDefaults(
  remembered: StoredPrintStartOptions,
  printStartOptions?: PrinterPrintStartOptions | null
): StoredPrintStartOptions {
  if (!printStartOptions) return remembered
  const bedLevel: PrintOnOffAutoMode = remembered.bedLevel === 'auto' && !printStartOptions.bedLevel.autoSupported
    ? 'on'
    : remembered.bedLevel
  const flowCalibration: PrintOnOffAutoMode = remembered.flowCalibration === 'auto' && !printStartOptions.flowCalibration.autoSupported
    ? 'on'
    : remembered.flowCalibration
  if (bedLevel === remembered.bedLevel && flowCalibration === remembered.flowCalibration) {
    return remembered
  }
  return { ...remembered, bedLevel, flowCalibration }
}

export function resolveFirstLayerInspectionDefault(
  printStartOptions: PrinterPrintStartOptions | null | undefined
): boolean {
  if (!printStartOptions?.firstLayerInspection.supported) return false
  return printStartOptions.firstLayerInspection.current ?? true
}

function parseStoredPrintOnOffAutoMode(value: unknown): PrintOnOffAutoMode | null {
  if (value === true) return 'on'
  if (value === false) return 'off'
  return value === 'off' || value === 'on' || value === 'auto' ? value : null
}

function parseStoredNozzleOffsetCalibrationMode(value: unknown): PrintNozzleOffsetCalibrationMode | null {
  if (value === true) return 'auto'
  if (value === false) return 'off'
  return value === 'off' || value === 'on' || value === 'auto' ? value : null
}

function resolveActorScope(actor: AuthBootstrap['actor'] | null | undefined): string {
  switch (actor?.type) {
    case 'user':
      return `user-${actor.userId ?? 'unknown'}`
    case 'service-account':
      return `service-account-${actor.serviceAccountId ?? 'unknown'}`
    default:
      return 'anonymous'
  }
}

function buildPrinterModelScope(printerModels: PrinterModel[]): string {
  const uniqueModels = Array.from(new Set(printerModels)).sort()
  return uniqueModels.length > 0 ? uniqueModels.join('+') : 'unknown'
}

function resolveSharedValue<T>(values: Array<T | null>): T | null {
  const knownValues = values.filter((value): value is T => value != null)
  if (knownValues.length === 0) return null
  const first = knownValues[0] as T
  return knownValues.every((value) => value === first) ? first : null
}