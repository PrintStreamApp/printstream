/**
 * Web-side AMS drying presentation helpers: plain-language labels for the
 * drying phase reported by the unit. The drying domain logic itself (filament
 * catalogue, presets, heat-distortion limits, risk assessment) is shared with
 * the API's command validation and lives in `@printstream/shared/ams-drying`.
 */
import type { AmsUnit } from '@printstream/shared'

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
