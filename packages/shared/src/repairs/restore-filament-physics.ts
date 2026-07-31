/**
 * Restores the per-filament physics a project lost, writing each key from the resolved presets.
 *
 * OWNS the layout problem. `rebindProjectFilamentPhysics` cannot do this: it only rewrites keys that
 * are still PRESENT, and here they are gone entirely. Writing them from scratch means knowing how
 * many columns each key needs per slot, and that is NOT one number — measured on a real dual-nozzle
 * project, `nozzle_temperature` carries 2 values per slot (variant-expanded) while `filament_density`
 * carries 1. A single guessed width would under- or over-size half the arrays, and an undersized
 * `slots x variants` array is what makes BambuStudio read out of bounds and die mid-slice (see
 * `flush-volumes-matrix.ts`).
 *
 * THE SOURCE OF TRUTH IS THE OPTION, NOT THE PRESET. Width is decided by BambuStudio's config
 * definition — `filament_options_with_variant`, mirrored in `variant-options.ts` — times
 * the variant count this project declares in `filament_extruder_variant`. It was previously taken
 * from whatever shape the resolved preset happened to carry, which is wrong in both directions: a
 * preset can spell a per-slot value out per variant, or carry a scalar for a variant-scoped key.
 * That mistake wrote `filament_density` and `chamber_temperatures` at variant width, and since
 * `parseProjectFilaments` sizes the material list from the LONGEST filament array, a 3-material
 * project reopened showing 6 — after which BambuStudio could bind neither the printer nor the
 * filaments and fabricated a `(<project>.3mf)` preset for each.
 *
 * CONTRACT: only writes keys EVERY resolved preset defines, and only when EVERY slot resolved. A key
 * some slot lacks is skipped whole and reported in `skippedKeys` — padding the gap with `''` is the
 * guess this module exists to refuse, and an empty value is itself what makes BambuStudio mint a
 * defaults-only preset. A scalar broadcasts across the variants; nothing is ever widened past what
 * the project declares.
 *
 * Detection is {@link inspectProjectFilamentPhysics}; see the `repairs/index.ts` contract for why
 * repair is user-invoked and never heals at rest.
 */
import { FILAMENT_SETTING_KEYS, filamentSettingsCatalog } from '../filament-settings.js'
import { FILAMENT_PRESET_DEFAULTS, FILAMENT_PRESET_OPTIONS } from '../generated/filament-preset-options.generated.js'
import { filamentVariantsPerSlot, isFilamentVariantOption } from '../variant-options.js'
import type { ProcessConfig } from '../process-settings.js'

/**
 * Keys whose per-slot shape we cannot reproduce, so authoring them can only make things worse.
 *
 * BambuStudio writes `filament_notes` as a bare `""` even on a three-filament project, where every
 * other filament option is a per-slot array. Authored the normal way it came out `["","",""]`, which
 * `diff()` sees as different from `""` — and one differing key is all it takes for BambuStudio to
 * mint a `(<project>.3mf)` copy instead of binding the user's preset. It is free-text notes with no
 * effect on the print, so leaving it to the default costs nothing.
 */
const UNAUTHORABLE_KEYS = new Set(['filament_notes'])

/** Keys that identify a filament rather than describe its physics; never touched here. */
const IDENTITY_KEYS = new Set([
  'filament_colour',
  'filament_type',
  'filament_settings_id',
  'filament_ids',
  'filament_nozzle_map',
  'filament_extruder_variant'
])

/** One slot's resolved preset, in slot order. Null for a slot whose preset did not resolve. */
export type FilamentPhysicsSource = ReadonlyArray<ProcessConfig | null>

export interface RestoredFilamentPhysics {
  /** Keys written, for the audit trail and to report a partial restore honestly. */
  restoredKeys: string[]
  /** Slots that had no resolved preset, so contributed nothing. */
  unresolvedSlots: number[]
  /** Keys left alone because some slot did not define them; reported so a partial restore is visible. */
  skippedKeys: string[]
}

/**
 * BambuStudio's serialization of a numeric value: no redundant decimals.
 *
 * A resolved preset can carry `"12.0"` where BambuStudio's own project writes `"12"` — the same
 * number, a different string. It matters because binding a slot to its preset requires EVERY
 * compared key to match, so a cosmetic `.0` is enough to make BambuStudio mint a `(<project>.3mf)`
 * copy instead. Non-numeric values (gcode, names, percents, `nil`) are returned untouched.
 */
function canonicalNumber(value: string): string {
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) return value
  const parsed = Number(value)
  return Number.isFinite(parsed) ? String(parsed) : value
}

function columnsFor(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    const columns = value.map((entry) => canonicalNumber(typeof entry === 'string' ? entry : String(entry)))
    return columns.length > 0 ? columns : null
  }
  if (typeof value === 'string') return [canonicalNumber(value)]
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)]
  return null
}

/**
 * Write the presets' physics into `record`, in place.
 *
 * Returns what it wrote. A no-op (no resolved presets, or presets defining nothing) returns empty
 * arrays and leaves `record` untouched, so callers can decide not to persist anything.
 */
export function restoreFilamentPhysics(
  record: Record<string, unknown>,
  sources: FilamentPhysicsSource
): RestoredFilamentPhysics {
  const slotCount = sources.length
  const unresolvedSlots = sources.map((config, index) => (config ? null : index + 1)).filter((slot): slot is number => slot !== null)
  // ALL-OR-NOTHING, because these arrays are POSITIONAL and the width is per-key, not per-slot. One
  // unresolved slot used to still consume its `width` columns, filled with empty strings — which
  // both wrote a guessed value (the module forbids exactly that) and, wherever width was 2, pushed
  // the array past the real slot count. `parseProjectFilaments` sizes the material list from the
  // LONGEST filament array, so a 3-material project reopened with 6 materials, the last three
  // duplicating the previous one. Seen on a real save: `nozzle_temperature` came back
  // `["245","245","245","245","",""]` for three slots, because the third slot's preset
  // (an inherited variant) resolves in a workspace catalogue but not in the anonymous one.
  //
  // Leaving the project untouched keeps it merely UNREPAIRED — it stays flagged and the user can
  // repair it from a host that resolves every slot — instead of trading one defect for a worse one.
  if (slotCount === 0 || unresolvedSlots.length > 0) return { restoredKeys: [], unresolvedSlots, skippedKeys: [] }

  // EVERY filament option in the catalogue, not merely the ones a resolved preset happened to carry.
  //
  // BambuStudio writes the COMPLETE filament block and reads an absent key as "not what the preset
  // says", so a key no preset mentioned — `pressure_advance`, `ironing_fan_speed`,
  // `default_filament_colour` and six others, none of which the resolver returns — left the project
  // looking deviant. BambuStudio then refused to bind the slot to the user's own preset and minted a
  // `(<project>.3mf)` copy instead. Writing only what we had is what made a repaired project open
  // wrong; writing the whole block is what BambuStudio itself does.
  //
  // Extra keys are safe in a way missing ones are not: a slot carrying MORE than BambuStudio would
  // write still binds (measured — our files have carried ~70 such keys throughout and the built-in
  // slots bound cleanly), while one short of it does not.
  const keys = new Set<string>()
  // BambuStudio's OWN filament option list, so the block is complete by its definition rather than
  // by our tune dialog's (see `filament-preset-options.ts`)...
  for (const key of FILAMENT_PRESET_OPTIONS) {
    if (IDENTITY_KEYS.has(key) || UNAUTHORABLE_KEYS.has(key)) continue
    keys.add(key)
  }
  // NOT unioned with "whatever the presets carry". A resolved preset is a preset DOCUMENT: besides
  // settings it holds bookkeeping — `type`, `instantiation`, `inherits`, `include`, `setting_id`,
  // `filament_id`, `compatible_printers` — and copying those into a project's config produced a file
  // BambuStudio refused to open at all ("invalid config file"), which is worse than the mis-binding
  // this was trying to fix. The vendor list above is already complete over the settings (it covers
  // `counter_coef_*`, `hole_coef_*`, `circle_compensation_speed`, `diameter_limit` and the rest that
  // the tune-dialog catalogue omits), so there is nothing left for a union to add.

  // The project's OWN variant layout decides how wide a variant-scoped key is here. Read once.
  const variantsPerSlot = filamentVariantsPerSlot(record, slotCount)

  const restoredKeys: string[] = []
  const skippedKeys: string[] = []
  for (const key of keys) {
    // A slot whose preset does not define the key takes the OPTION'S DEFAULT — but only when at
    // least ONE slot supplied a value, so the array has real content to be positional about.
    //
    // A key NO slot defines is omitted instead. BambuStudio builds the comparison config by starting
    // from the DEFAULT preset and overlaying only the keys the project carries
    // (`load_external_preset`), so an absent key already reads as its default — writing it changes
    // nothing except the chance of getting its SHAPE wrong. That is not hypothetical:
    // `filament_notes` written as `["","",""]` differed from BambuStudio's scalar `""`, and one
    // differing key is enough for it to mint a `(<project>.3mf)` copy instead of binding the preset.
    // Default in order of authority: BambuStudio's PrintConfig default for the option, then the tune
    // dialog's catalogue (same source, narrower list, kept as a backstop).
    const perSlotColumns = sources.map((config) => columnsFor(config?.[key]))
    // WIDTH, in two cases:
    //  - VARIANT-scoped keys take the project's variant count. Never the preset's shape: a preset may
    //    spell a per-slot value out per variant or carry a scalar for a variant key, and trusting it
    //    produced arrays of the wrong length (High Flow overwritten with the Standard value).
    //  - Everything else takes the PRESET's own column count, which is not always 1. BambuStudio
    //    declares these as plain vectors with no column count, and a real preset carries 4 columns
    //    for `filament_dev_ams_drying_temperature` (the drying stages) and 2 for
    //    `filament_dev_ams_drying_ams_limitations`. Forcing them to 1 made every one differ from the
    //    preset, and BambuStudio binds a slot only when NO compared key differs.
    const sourceWidth = perSlotColumns.find((columns) => columns !== null)?.length ?? 1
    const width = isFilamentVariantOption(key) ? variantsPerSlot : sourceWidth
    const fallback = FILAMENT_PRESET_DEFAULTS[key] ?? filamentSettingsCatalog.options[key]?.default
    // No source value AND no default means we have nothing truthful to write. OMIT the key rather
    // than emit `''`: BambuStudio omits such options itself (`bed_type` is in its filament option
    // list and absent from its saves), and an empty string is as much a deviation from the preset as
    // an absence — it is what made BambuStudio mint a project preset in the first place.
    // Nothing to write and nothing to default to.
    if (fallback === undefined && perSlotColumns.every((columns) => columns === null)) {
      skippedKeys.push(key)
      continue
    }
    // A slot short of a key whose option has no default cannot be completed truthfully.
    if (fallback === undefined && perSlotColumns.some((columns) => columns === null)) {
      skippedKeys.push(key)
      continue
    }
    const perSlot = perSlotColumns.map((columns) => columns ?? [fallback as string])
    // A source SHORT of the width cannot be completed without inventing a column, and the variants
    // genuinely differ — BambuStudio's own file carries `filament_max_volumetric_speed: ["25","40"]`
    // for one slot. Repeating column 0 wrote 25 for High Flow, and BambuStudio reported it as the
    // user's change. Inheritance is where a missing column gets filled (from the parent preset); by
    // the time a source reaches here it is either complete or unusable.
    // Short of the width means a variant column is genuinely unknown — the variants differ, so
    // repeating column 0 would invent one (that is how High Flow got the Standard value). A source
    // that came from the option default is uniform by definition, so widen that one; anything else
    // short is unusable.
    const widened = perSlot.map((columns) => {
      const values = columns as string[]
      return values.length === 1 && values[0] === fallback ? Array.from({ length: width }, () => fallback as string) : values
    })
    if (widened.some((columns) => columns.length < width)) {
      skippedKeys.push(key)
      continue
    }
    // Anything WIDER is truncated to what this project declares, so a preset from a machine with
    // more variants cannot stretch the array past the slot layout.
    record[key] = widened.flatMap((columns) => columns.slice(0, width))
    restoredKeys.push(key)
  }

  return { restoredKeys: restoredKeys.sort(), unresolvedSlots, skippedKeys: skippedKeys.sort() }
}
