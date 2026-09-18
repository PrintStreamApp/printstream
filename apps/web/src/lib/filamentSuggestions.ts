/**
 * App-wide seed values for free-entry filament identity fields. Workspace data
 * is layered above these suggestions by each consumer, so a new installation
 * starts useful and the choices learn from the user's filament library.
 */

import { FILAMENT_PRESETS } from '../data/filamentSetupCatalog'
import { BAMBU_FILAMENT_PRESET_NAMES, filamentProductLineFromPresetName } from '@printstream/shared'

// Share the printer setup catalogue so reinforced materials are offered as types everywhere.
export const FILAMENT_MATERIAL_SUGGESTIONS = FILAMENT_PRESETS.map((preset) => preset.type)

// Use the canonical short Bambu name produced by the filament identity resolver.
export const FILAMENT_BRAND_SUGGESTIONS = [
  'Bambu', 'Polymaker', 'eSUN', 'Overture', 'Prusament', 'Hatchbox',
  'SUNLU', 'Inland', 'Elegoo', 'ColorFabb', 'Fillamentum', 'Atomic Filament'
] as const

/** Known product lines share the same spellings as AMS and slicing identities. */
export const FILAMENT_PRODUCT_LINE_SUGGESTIONS = [...new Set(
  Object.values(BAMBU_FILAMENT_PRESET_NAMES)
    .map(filamentProductLineFromPresetName)
    .filter((line): line is string => line != null)
)].sort((left, right) => left.localeCompare(right))
