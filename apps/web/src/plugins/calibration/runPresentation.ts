/**
 * Shared presentation helpers for a calibration run, used by both the Calibration
 * view and the slice/print progress dialog so a run reads the same everywhere.
 */
import { isAutomaticPressureAdvance, type CalibrationRun, type CalibrationResult } from '@printstream/shared'

/** Human title for a run, e.g. "Pressure advance tower" or "Flow ratio: coarse (pass 1)". */
export function runTitle(run: CalibrationRun): string {
  if (isAutomaticPressureAdvance(run.parameters)) return 'Automatic pressure advance (Micro Lidar)'
  switch (run.parameters.kind) {
    case 'pressureAdvance': return 'Pressure advance tower'
    case 'flowRatio': return `Flow ratio: ${run.parameters.pass === 1 ? 'coarse' : 'fine'} (pass ${run.parameters.pass})`
    case 'temperature': return 'Temperature tower'
    case 'maxVolumetricSpeed': return 'Max volumetric speed tower'
    case 'vfa': return 'VFA tower'
    case 'retraction': return 'Retraction tower'
  }
}

/** Describe hardware targets without presenting the original measurement model as applicability. */
export function calibrationPrinterTargetLabel(result: CalibrationResult, printerNames: ReadonlyMap<string, string>): string {
  if (!result.printerTarget) return result.printerModel
  if (result.printerTarget.scope === 'models') return result.printerTarget.models.join(', ')
  return result.printerTarget.printerIds.map((id) => printerNames.get(id) ?? 'Unavailable printer').join(', ')
}

/** User-facing saved calibration kind label. */
export function calibrationKindLabel(kind: CalibrationRun['kind']): string {
  switch (kind) {
    case 'pressureAdvance': return 'Pressure advance (K value)'
    case 'flowRatio': return 'Flow ratio'
    case 'temperature': return 'Temperature'
    case 'maxVolumetricSpeed': return 'Max volumetric speed'
    case 'vfa': return 'VFA speed'
    case 'retraction': return 'Retraction'
  }
}

/** Format a saved value with the unit owned by its calibration kind. */
export function calibrationValueLabel(kind: CalibrationRun['kind'], value: number): string {
  switch (kind) {
    case 'pressureAdvance': return `K ${value.toFixed(4)}`
    case 'flowRatio': return value.toFixed(3)
    case 'temperature': return `${Math.round(value)} C`
    case 'maxVolumetricSpeed': return `${value.toFixed(1)} mm3/s`
    case 'vfa': return `${Math.round(value)} mm/s`
    case 'retraction': return `${value.toFixed(1)} mm`
  }
}
