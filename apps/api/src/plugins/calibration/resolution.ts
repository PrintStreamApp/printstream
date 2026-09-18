/**
 * Server-side saved calibration resolution. The shared matcher owns hardware,
 * nozzle and filament precedence for both this module and web slicing controls.
 * Callers narrow candidates to one kind; this module has no database dependency.
 */
import {
  resolveTargetedCalibrationValue,
  type CalibrationFilamentIdentity,
  type CalibrationKind,
  type CalibrationPrinterTarget,
  type CalibrationValueCandidate
} from '@printstream/shared'

/** The filament a value could apply to: a spool id plus its identity fields. */
export type CalibrationFilament = CalibrationFilamentIdentity

/** A stored result, reduced to the fields resolution needs. */
export interface ResolvableCalibrationResult extends CalibrationValueCandidate {
  printerModel: string
  nozzleDiameter: string
  printerTarget?: CalibrationPrinterTarget
  pressureAdvanceMode?: 'native' | 'linear'
  kind: CalibrationKind
}

/** Pick the eligible saved value, or null when the target or filament does not match. */
export function resolveCalibrationValue(
  candidates: ResolvableCalibrationResult[],
  filament: CalibrationFilament,
  target: { printerId?: string | null; printerModel: string; nozzleDiameter: string }
): ResolvableCalibrationResult | null {
  return resolveTargetedCalibrationValue(candidates, filament, target)
}
