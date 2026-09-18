/** Resolve library subtype metadata to the printer's supported material types without losing composites. */
import { FILAMENT_PRESETS } from './filamentSetupCatalog'

/** Prefer an exact supported subtype; preserve unknown subtypes as unsupported rather than guessing a base polymer. */
export function printerMaterialType(type: string | null | undefined, subtype: string | null | undefined): string {
  const base = type?.trim().toUpperCase() ?? ''
  const variant = subtype?.trim().toUpperCase() ?? ''
  const exact = FILAMENT_PRESETS.find((preset) => preset.type === variant)
  if (exact) return exact.type
  // Reinforced materials must never silently become their unfilled base type.
  if (/(?:^|[-\s])(CF|GF|ESD)(?:$|[-\s])/.test(variant)) return variant
  return base
}
