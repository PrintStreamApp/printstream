/**
 * Bridges explicit pressure-advance overrides to Bambu's filament activation script.
 * Studio ignores enable_pressure_advance on Bambu machines. Its filament-start hook runs
 * after machine startup and on material changes, so the K applies to the active tool only.
 * Other printer families retain their slicer's native pressure-advance implementation.
 */
import { canonicalBambuModelKey } from './bambu-model-keys.js'
import type { ProcessConfig } from './process-settings.js'
import { MAX_PA_K_VALUE } from './calibration.js'
import { pressureAdvanceModeSchema } from './calibration.js'
import { bambuPressureAdvanceGcode, PRESSURE_ADVANCE_MODE_SETTING } from './pressure-advance-gcode.js'

const START = '; PrintStream pressure advance begin'
const END = '; PrintStream pressure advance end'

/** Preserve the user's script, replacing only a previously generated K block. */
export function withFilamentPressureAdvance(
  record: Record<string, unknown>,
  overrides: Record<number, ProcessConfig>,
  configs: Array<ProcessConfig | null>
): Record<number, ProcessConfig> {
  if (!canonicalBambuModelKey(record.printer_model)) return overrides
  const next = { ...overrides }
  for (const [position, settings] of Object.entries(overrides)) {
    const enabled = first(settings.enable_pressure_advance)
    if (enabled !== '1' && enabled !== '0') continue
    const raw = first(settings.pressure_advance)
    const k = raw == null || raw.trim() === '' ? NaN : Number(raw)
    if (enabled === '1' && (!Number.isFinite(k) || k < 0 || k > MAX_PA_K_VALUE)) {
      throw new Error(`Bambu K value must be between 0 and ${MAX_PA_K_VALUE}`)
    }
    const index = Number(position) - 1
    const stored = record.filament_start_gcode
    const script = first(settings.filament_start_gcode)
      ?? (Array.isArray(stored) ? first(stored[index]) : first(stored))
      ?? first(configs[index]?.filament_start_gcode)
      ?? ''
    const clean = script.replace(/; PrintStream pressure advance begin\r?\n[\s\S]*?; PrintStream pressure advance end\r?\n?/g, '')
    // Do not set K to zero for Off: that would disable the printer's own compensation.
    const mode = pressureAdvanceModeSchema.parse(first(settings[PRESSURE_ADVANCE_MODE_SETTING]) ?? 'native')
    const suffix = enabled === '1' ? `${START}\n${bambuPressureAdvanceGcode(k, mode)}\n${END}\n` : ''
    const engineSettings = { ...settings }
    delete engineSettings[PRESSURE_ADVANCE_MODE_SETTING]
    next[Number(position)] = {
      ...engineSettings,
      filament_start_gcode: clean + (clean && !clean.endsWith('\n') ? '\n' : '') + suffix
    }
  }
  return next
}

function first(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}
