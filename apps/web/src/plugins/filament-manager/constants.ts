/** Shared constants for the filament-manager web plugin. */

/** At or below this remaining %, a spool's bar turns warning. Mirrors the API. */
export const LOW_REMAIN_PERCENT = 25

export const PLUGIN_NAME = 'filament-manager'

/**
 * localStorage keys for the spool directory's persisted display preferences
 * (sort, grouping, filters, page size, view mode). The Filament tab and the
 * AMS-slot spool picker each keep their own, so a filter set while picking a
 * spool to load never leaks into the main inventory view.
 */
export const SPOOL_DIRECTORY_PREFS_KEY = 'printstream.filament.directory'
export const SPOOL_PICKER_PREFS_KEY = 'printstream.filament.picker'

export const PAGE_SIZE_OPTIONS = [
  { value: 24, label: '24 per page' },
  { value: 48, label: '48 per page' },
  { value: 96, label: '96 per page' }
] as const

// Compatibility re-export for filament-manager callers. The values are app-wide
// because calibration and spool editing offer the same filament vocabulary.
export {
  FILAMENT_BRAND_SUGGESTIONS,
  FILAMENT_MATERIAL_SUGGESTIONS,
  FILAMENT_PRODUCT_LINE_SUGGESTIONS
} from '../../lib/filamentSuggestions'
