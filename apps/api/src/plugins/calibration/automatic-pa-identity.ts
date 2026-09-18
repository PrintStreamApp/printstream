/** Physical-filament checks for automatic PA, separate from editable saved-result targeting. */
import { normalizeHexColor, type AmsSlot, type CalibrationFilamentIdentity } from '@printstream/shared'
import type { AutomaticPaSetup } from './automatic-pa-protocol.js'

/** Preserve reinforced material types; normalize only spelling case and surrounding whitespace. */
export function automaticPaMaterialTypesMatch(preset: string | undefined, tray: string): boolean {
  return Boolean(preset?.trim()) && preset!.trim().toUpperCase() === tray.trim().toUpperCase()
}

/** Capture tracked identity and raw colours so a spool swap cannot be hidden by a tracked colour label. */
export function automaticPaFilamentSnapshot(slot: AmsSlot, identity: CalibrationFilamentIdentity): NonNullable<AutomaticPaSetup['observedFilament']> {
  return {
    ...identity,
    color: normalizeHexColor(slot.color),
    colors: (slot.colors ?? []).map((color) => normalizeHexColor(color) ?? color)
  }
}

/** Fail closed for prepared runs without a snapshot, or any changed tracked identity or tray colour. */
export function automaticPaFilamentMatches(
  expected: AutomaticPaSetup['observedFilament'],
  current: NonNullable<AutomaticPaSetup['observedFilament']>
): boolean {
  if (!expected) return false
  return expected.spoolId === current.spoolId
    && expected.brand === current.brand
    && expected.filamentType === current.filamentType
    && expected.materialSubtype === current.materialSubtype
    && expected.colorName === current.colorName
    && expected.color === current.color
    && expected.colors.length === current.colors.length
    && expected.colors.every((color, index) => color === current.colors[index])
}
