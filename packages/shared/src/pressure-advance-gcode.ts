/** Shared K command policy for calibration tests and saved-value application. */
import { MAX_PA_K_VALUE, type PressureAdvanceMode } from './calibration.js'

/** Internal slice metadata, consumed before filament settings are written to the engine input. */
export const PRESSURE_ADVANCE_MODE_SETTING = 'printstream_pressure_advance_mode'

/** Emit Bambu direct-drive K commands. Never reinterpret an unmarked/native value as linear. */
export function bambuPressureAdvanceGcode(k: number, mode: PressureAdvanceMode = 'native'): string {
  if (!Number.isFinite(k) || k < 0 || k > MAX_PA_K_VALUE) {
    throw new Error(`Bambu K value must be between 0 and ${MAX_PA_K_VALUE}`)
  }
  // Bambu's published linear-mode recipe, also used by Orca's Bambu GCodeWriter:
  // https://forum.bambulab.com/t/flow-calibration/892/11
  return `M400\nM900 K${k}${mode === 'linear' ? ' L1000 M10' : ''}`
}
