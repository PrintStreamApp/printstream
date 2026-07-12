/**
 * Re-export shim: the canonical Bambu model keys, aliases, and
 * process-compatibility families now live in `@printstream/shared`
 * (`bambu-model-keys.ts`), shared with the slicer service's cross-model
 * machine-switch guard so the two can never drift. Import from here (or the
 * shared package directly) in web code.
 */
export {
  KNOWN_BAMBU_PRINTER_MODEL_KEYS,
  bambuModelKeysAreCompatible,
  canonicalBambuModelKey,
  normalizeBambuStudioPrinterModelOption,
  resolveBambuPrinterModelAliases
} from '@printstream/shared'
