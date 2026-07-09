/**
 * Shared presentation helpers for a calibration run, used by both the Calibration
 * view and the slice/print progress dialog so a run reads the same everywhere.
 */
import type { CalibrationRun } from '@printstream/shared'

/** Human title for a run, e.g. "Pressure advance tower" or "Flow ratio — coarse (pass 1)". */
export function runTitle(run: CalibrationRun): string {
  if (run.parameters.kind === 'pressureAdvance') return 'Pressure advance tower'
  return `Flow ratio — ${run.parameters.pass === 1 ? 'coarse' : 'fine'} (pass ${run.parameters.pass})`
}
