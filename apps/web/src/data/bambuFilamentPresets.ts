/**
 * Re-export shim: the Bambu filament preset catalogue moved to
 * `@printstream/shared` (bambu-filament-presets.ts) so the API resolves preset
 * ids identically (spool ingestion, calibration identity). Import from shared
 * in new code; this shim keeps existing web imports stable.
 */
export {
  BAMBU_FILAMENT_PRESET_NAMES,
  brandFromPresetName,
  filamentPresetBrandFromId,
  filamentPresetNameFromId
} from '@printstream/shared'
