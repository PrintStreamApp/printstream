/**
 * Re-export shim: the Bambu colour swatch catalogue moved to
 * `@printstream/shared` (bambu-colors.ts) so the API names colours identically
 * (spool ingestion, calibration identity). Note `bambuSwatchForHex` is now
 * material-scoped when a material is given — no cross-family fallback. Import
 * from shared in new code; this shim keeps existing web imports stable.
 */
export {
  BAMBU_COLOR_SWATCHES,
  bambuColorName,
  bambuColorsForMaterial,
  bambuMaterialFromPresetName,
  bambuMaterialFromType,
  bambuSwatchForHex,
  readableTextColor,
  type BambuColorSwatch
} from '@printstream/shared'
