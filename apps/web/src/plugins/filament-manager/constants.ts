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

/**
 * Seed suggestions for the add/edit spool autocompletes. They bootstrap the
 * dropdowns before a workspace has its own spools; the user's existing spool
 * brands/variants/vendors are merged in on top so the list learns over time.
 */
export const FILAMENT_MATERIAL_SUGGESTIONS = [
  'PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PC', 'PVA', 'PA', 'PLA-CF', 'PETG-CF', 'Nylon', 'HIPS'
] as const

export const FILAMENT_BRAND_SUGGESTIONS = [
  'Bambu Lab', 'Polymaker', 'eSUN', 'Overture', 'Prusament', 'Hatchbox',
  'SUNLU', 'Inland', 'Elegoo', 'ColorFabb', 'Fillamentum', 'Atomic Filament'
] as const

export const FILAMENT_VARIANT_SUGGESTIONS = [
  'PLA Basic', 'PLA Matte', 'PLA Silk', 'PLA+', 'PLA-CF',
  'PETG', 'PETG HF', 'PETG-CF', 'ABS', 'ASA', 'TPU 95A', 'PA-CF', 'PC'
] as const
