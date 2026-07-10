/**
 * Re-export shim: the Bambu encoded multi-colour catalogue moved to
 * `@printstream/shared` (bambu-encoded-multi-colors.ts). Import from shared in
 * new code; this shim keeps existing web imports stable.
 */
export {
  BAMBU_ENCODED_MULTI_COLORS,
  findBambuEncodedMultiColor,
  findBambuEncodedMultiColorAlias,
  type BambuEncodedMultiColor
} from '@printstream/shared'
