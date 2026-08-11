/**
 * The `filament_self_index` invariant for Bambu `project_settings.config`.
 *
 * OWNS the rule that BambuStudio enforces at LOAD time in `PresetBundle.cpp`, gated on the project
 * carrying `extruder_variant_list`:
 *
 *     if (extruder_variant_count != filament_self_indice.size()
 *         || extruder_variant_count < num_filaments)
 *         throw RuntimeError("Invalid configuration file: " + name_or_path);
 *
 * Break it and Bambu Studio refuses to OPEN the project at all — the user sees "Invalid
 * configuration file", plus a misleading "The file does not contain any geometry data" because the
 * throw aborts the load before the meshes are read. Our own CLI slice path is more tolerant, which
 * is exactly how this hid: files sliced fine and simply could not be opened in Bambu Studio.
 *
 * `filament_self_index` is 1-BASED and repeats per variant row — BambuStudio scans it for the first
 * row matching each filament id to locate that filament's variant block. Absence is NOT benign: the
 * option's default is a ONE-element vector, so a missing key compares as size 1 against a
 * multi-row variant list and throws.
 *
 * Counterpart: `flush-volumes-matrix.ts`, which owns the sibling sizing invariant. Both exist
 * because a project rewritten by us must stay loadable by the tool that authored it.
 */

/** Non-TPU filaments share the standard variants; a TPU slot claims every printer variant. */
function isTpu(value: string): boolean {
  return /\btpu\b/i.test(value)
}

function unique(values: readonly string[]): string[] {
  const ordered = new Set<string>()
  for (const value of values) {
    if (value.trim().length > 0) ordered.add(value)
  }
  return [...ordered]
}

/**
 * The variant rows each filament owns, in `filament_extruder_variant` order.
 *
 * Blocks are NOT uniform width — that is the whole reason the index cannot be derived from a row
 * count alone, and why this and the variant array must be produced together.
 */
export function buildFilamentVariantRows(
  printerExtruderVariants: readonly string[],
  filamentTypes: readonly string[]
): { variants: string[]; selfIndex: string[] } {
  const shared = unique(printerExtruderVariants.filter((variant) => !isTpu(variant)))
  const fallback = shared.length > 0 ? shared : unique(printerExtruderVariants)
  if (filamentTypes.length === 0) {
    return { variants: fallback, selfIndex: fallback.map(() => '1') }
  }

  const variants: string[] = []
  const selfIndex: string[] = []
  filamentTypes.forEach((filamentType, index) => {
    const rows = isTpu(filamentType) ? unique(printerExtruderVariants) : fallback
    for (const row of rows) {
      variants.push(row)
      selfIndex.push(String(index + 1))
    }
  })
  return { variants, selfIndex }
}

/**
 * Bring a project's `filament_self_index` back in line with its `filament_extruder_variant`,
 * WITHOUT touching the variant array itself (callers that rebuild the layout wholesale use
 * {@link buildFilamentVariantRows} instead).
 *
 * @returns the index to write, or null when there is nothing to do — the project has no variant
 *   topology, the existing index already matches, or the shape cannot be reconstructed with
 *   confidence. Returning null rather than guessing matters: a WRONG index is as fatal as a
 *   missing one, and the honest failure is to leave the file as it was.
 */
export function repairFilamentSelfIndex(record: Record<string, unknown>): string[] | null {
  // The whole check is gated on this key in BambuStudio; without it the index is unused.
  if (!Array.isArray(record.extruder_variant_list) || record.extruder_variant_list.length === 0) return null

  const variants = Array.isArray(record.filament_extruder_variant)
    ? record.filament_extruder_variant.map((entry) => String(entry))
    : []
  if (variants.length === 0) return null

  const existing = Array.isArray(record.filament_self_index) ? record.filament_self_index : null
  if (existing && existing.length === variants.length) return null

  const filamentTypes = Array.isArray(record.filament_type)
    ? record.filament_type.map((entry) => String(entry))
    : []
  const printerVariants = Array.isArray(record.printer_extruder_variant)
    ? record.printer_extruder_variant.map((entry) => String(entry))
    : []

  // Preferred: rebuild the real per-filament blocks and confirm they describe the SAME row count
  // the project already has. A mismatch means the two disagree about the layout, and inventing an
  // index for rows we cannot attribute would trade one fatal shape for another.
  if (printerVariants.length > 0 && filamentTypes.length > 0) {
    const rebuilt = buildFilamentVariantRows(printerVariants, filamentTypes)
    if (rebuilt.variants.length === variants.length) return rebuilt.selfIndex
  }

  // Fallback for a project with no printer variant vocabulary to reason from: uniform blocks, but
  // only when the rows divide evenly among the filaments.
  if (filamentTypes.length > 0 && variants.length % filamentTypes.length === 0) {
    const width = variants.length / filamentTypes.length
    return variants.map((_, row) => String(Math.floor(row / width) + 1))
  }

  return null
}

/**
 * Recompute `filament_self_index` for the CURRENT filament order, regardless of whether the stored
 * index still has the right length.
 *
 * Used by `applyFilamentList` after it permutes the per-filament arrays: uniform variant blocks
 * make the index order-invariant (`[1,1,2,2]` describes any order of two same-width materials),
 * but blocks are NOT uniform — a moved TPU slot changes the widths and the stored index silently
 * misdescribes the layout while keeping the length that {@link repairFilamentSelfIndex}'s
 * length-only check passes. Same derivation and same refusal contract as the repair: null when the
 * project has no variant topology or the rebuilt layout disagrees with the stored row count,
 * because a plausible-looking wrong index is exactly as fatal as the defect being fixed.
 */
export function rebuildFilamentSelfIndex(record: Record<string, unknown>): string[] | null {
  if (!Array.isArray(record.extruder_variant_list) || record.extruder_variant_list.length === 0) return null
  if (!Array.isArray(record.filament_self_index)) return null
  const filamentTypes = Array.isArray(record.filament_type)
    ? record.filament_type.map((entry) => String(entry))
    : []
  const printerVariants = Array.isArray(record.printer_extruder_variant)
    ? record.printer_extruder_variant.map((entry) => String(entry))
    : []
  if (filamentTypes.length === 0 || printerVariants.length === 0) return null
  const rebuilt = buildFilamentVariantRows(printerVariants, filamentTypes)
  const variants = Array.isArray(record.filament_extruder_variant) ? record.filament_extruder_variant : null
  if (variants && rebuilt.variants.length !== variants.length) return null
  return rebuilt.selfIndex
}

/** What a project's stored variant index looks like next to what its topology requires. */
export interface FilamentSelfIndexInspection {
  /** Variant rows the project declares (`filament_extruder_variant`). */
  variantRows: number
  /** Stored index entries. 0 when the key is ABSENT, which IS a defect here — BambuStudio's
   *  default for the option is a one-element vector, so absence fails its equality check. */
  actualLength: number
  filamentCount: number
  inconsistent: boolean
  /** True when we can produce a correct replacement; false means "broken but not safely fixable". */
  repairable: boolean
}

/**
 * Inspect a raw `project_settings.config` JSON string for the load-time invariant.
 *
 * Returns null when the settings are absent/unparseable, or when the project carries no variant
 * topology at all — BambuStudio only runs the check for projects with `extruder_variant_list`, so
 * everything else is genuinely unaffected rather than "healthy by luck".
 */
export function inspectProjectFilamentSelfIndex(
  projectSettingsJson: string | null | undefined
): FilamentSelfIndexInspection | null {
  if (!projectSettingsJson) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  if (!Array.isArray(record.extruder_variant_list) || record.extruder_variant_list.length === 0) return null

  const variantRows = Array.isArray(record.filament_extruder_variant) ? record.filament_extruder_variant.length : 0
  if (variantRows === 0) return null
  const actualLength = Array.isArray(record.filament_self_index) ? record.filament_self_index.length : 0
  const filamentCount = Array.isArray(record.filament_colour) ? record.filament_colour.length : 0

  return {
    variantRows,
    actualLength,
    filamentCount,
    inconsistent: actualLength !== variantRows || variantRows < filamentCount,
    repairable: repairFilamentSelfIndex(record) !== null
  }
}
