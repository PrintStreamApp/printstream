/**
 * BambuStudio profile-metadata extraction helpers shared by the API
 * (`apps/api/src/lib/slicing-profiles.ts`) and the standalone slicer worker
 * (`apps/slicer/src/index.ts`). Both read the same BambuStudio preset JSON to
 * derive the filtering metadata surfaced in the slice dialog, so the parsers
 * must agree byte-for-byte. The single source of truth lives here.
 *
 * `extractProfileMetadata` is the superset: it also reads the machine-only
 * `default_print_profile` / `default_filament_profile` fallbacks. Callers that
 * don't carry those fields (e.g. the API's `ProfileMetadata` pick) simply drop
 * them downstream — the extra keys are tolerated, never required.
 */

/** Split a `;`/`,`-delimited string or array into a de-duplicated list of trimmed non-empty strings. */
export function stringList(value: unknown): string[] {
  const rawValues = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[;,]/) : []
  return Array.from(new Set(rawValues
    .map((entry) => typeof entry === 'string' ? entry.trim() : '')
    .filter(Boolean)))
}

/** First entry of {@link stringList}, falling back to the raw scalar string. */
export function firstString(value: unknown): string | undefined {
  return stringList(value)[0] ?? stringValue(value)
}

/** Parse a `;`/`,`-delimited string or array into a de-duplicated list of positive finite numbers. */
export function numberList(value: unknown): number[] {
  const rawValues = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[;,]/) : []
  return Array.from(new Set(rawValues
    .map((entry) => typeof entry === 'number' ? entry : typeof entry === 'string' ? Number.parseFloat(entry) : Number.NaN)
    .filter((entry) => Number.isFinite(entry) && entry > 0)))
}

/** A trimmed non-empty string, or undefined for anything else. */
export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** First entry of {@link numberList}, i.e. the leading positive number of a `;`/`,`-delimited value. */
export function firstNumber(value: unknown): number | undefined {
  return numberList(value)[0]
}

/**
 * Read a BambuStudio `ConfigOptionBools` field, which serializes as the strings
 * `"1"`/`"0"` (usually inside a one-entry array), into a real boolean.
 *
 * Returns `undefined` only when the field is **absent**, and that distinction
 * matters: metadata merges an `inherits` parent with `child ?? parent`, so an
 * explicit `"0"` on a child must resolve to `false` and override an inherited
 * `true` rather than falling through to it.
 */
export function booleanValue(value: unknown): boolean | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') return raw !== 0
  const trimmed = stringValue(raw)?.toLowerCase()
  if (trimmed === '1' || trimmed === 'true') return true
  if (trimmed === '0' || trimmed === 'false') return false
  return undefined
}

/**
 * Drop empty strings, empty arrays, and nullish values so absent metadata stays
 * absent. `false` and `0` are deliberately KEPT — they are meaningful values,
 * not absence, and dropping them would let an inherited `true` leak past an
 * explicit override during the `??` merge.
 */
export function omitEmptyMetadata<T extends Record<string, string | string[] | number | number[] | boolean | undefined>>(metadata: T): Partial<T> {
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0
    return value != null && value !== ''
  })) as Partial<T>
}

/**
 * Read BambuStudio profile JSON into the filtering metadata used by the slice
 * dialog. BambuStudio's own JSON fields are authoritative; UI name parsing is
 * only a fallback for project/imported profiles that omit them. Machine-only
 * `default_print_profile` / `default_filament_profile` describe the presets
 * BambuStudio falls back to when the current preset is incompatible with the
 * selected printer (used to mirror that fallback on a cross-model switch).
 */
export function extractProfileMetadata(record: Record<string, unknown>) {
  return omitEmptyMetadata({
    filamentIds: stringList(record.filament_id),
    filamentType: firstString(record.filament_type),
    filamentIsSupport: booleanValue(record.filament_is_support),
    filamentVendor: firstString(record.filament_vendor),
    layerHeight: firstNumber(record.layer_height),
    printerModels: stringList(record.printer_model),
    compatiblePrinters: stringList(record.compatible_printers),
    compatiblePrints: stringList(record.compatible_prints),
    nozzleDiameters: numberList(record.nozzle_diameter),
    plateTypes: stringList(record.curr_bed_type),
    compatiblePrintersCondition: stringValue(record.compatible_printers_condition),
    compatiblePrintsCondition: stringValue(record.compatible_prints_condition),
    defaultProcessProfile: firstString(record.default_print_profile),
    defaultFilamentProfiles: stringList(record.default_filament_profile)
  })
}
