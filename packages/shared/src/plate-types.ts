/**
 * Bambu bed/plate-type canonicalization. BambuStudio serializes the project-global
 * `curr_bed_type` in `project_settings.config` (and the per-plate `bed_type` metadata in
 * `model_settings.config`) as the exact enum values below (`s_keys_map_BedType`), while our
 * UI also circulates code-form tokens (`textured_pei_plate`) and display labels
 * ("Bambu Cool Plate SuperTack"). {@link canonicalCurrBedType} maps any of those spellings
 * onto the serialized enum value so a written project parses in BambuStudio and the CLI.
 */

/** `curr_bed_type` values exactly as BambuStudio serializes them. */
export const BAMBU_CURR_BED_TYPE_VALUES = [
  'Cool Plate',
  'Engineering Plate',
  'High Temp Plate',
  'Textured PEI Plate',
  'Supertack Plate'
] as const

/** Spelling-insensitive lookup key: lowercase with everything non-alphanumeric dropped. */
function plateTypeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

const CANONICAL_BY_KEY: ReadonlyMap<string, string> = new Map([
  // The serialized enum values themselves plus our UI's code-form tokens collapse to the
  // same keys (e.g. "Cool Plate" and "cool_plate" -> "coolplate").
  ...BAMBU_CURR_BED_TYPE_VALUES.map((value): [string, string] => [plateTypeKey(value), value]),
  // BambuStudio's display labels where they differ from the enum value.
  [plateTypeKey('Smooth PEI Plate / High Temp Plate'), 'High Temp Plate'],
  [plateTypeKey('Bambu Cool Plate SuperTack'), 'Supertack Plate']
])

/**
 * Resolve any plate-type spelling to the `curr_bed_type` value BambuStudio serializes.
 * Unknown values pass through trimmed (they most likely came from a project's existing
 * `curr_bed_type`, which is already in serialized form); null/blank stays null.
 */
export function canonicalCurrBedType(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return CANONICAL_BY_KEY.get(plateTypeKey(trimmed)) ?? trimmed
}
