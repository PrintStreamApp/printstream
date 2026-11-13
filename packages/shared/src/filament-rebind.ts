/**
 * Filament-physics REBIND for a machine retarget: the data half of BambuStudio's machine-switch
 * semantics. When BambuStudio switches printers, `PresetBundle::update_compatible` re-selects
 * every filament preset by ALIAS (the machine-agnostic family name, "Bambu PETG HF") with top
 * priority, so the effective per-filament values become the NEW machine variant's; only the
 * user's own recorded overrides survive. Our save-side retarget rewrote the machine topology but
 * carried the per-filament numeric columns forward verbatim, leaving the OLD variant's values
 * baked under the new machine: "fossils" that read as phantom "changed vs preset" markers ever
 * after (production case: X1C's engine-default `pre_start_fan_time` 0 flagged against H2D's
 * stock 2 forever).
 *
 * Contract:
 * - Only keys PRESENT in the record are rewritten. An absent key already means "the preset's
 *   value at load", which re-derives for the new machine on its own: writing it would only
 *   grow the file.
 * - A slot's key recorded in `different_settings_to_system` is a genuine user override: its OLD
 *   value is preserved (broadcast to the new variant width), never replaced by the preset.
 * - A present key the new preset does not define drops for non-overridden slots (absence =
 *   preset default): kept only while some slot's override needs the column to exist.
 * - Rows follow the RETARGETED record's declared layout (`filament_extruder_variant` owned per row
 *   by `filament_self_index`, which the machine retarget rebuilt and re-laid values into), and are
 *   NOT a uniform width: a TPU slot owns more rows. Old values are read at those rows; preset values
 *   are matched to them by variant name (`filament-variant-rows.ts`). The layout's own two columns
 *   are never rewritten here.
 *
 * Pure, a parsed record + resolved preset configs in, a new record out. The API resolves the
 * rebind targets (name/alias matching + the slicer's profile resolver) in
 * `apps/api/src/lib/save-retarget.ts`; this module never fetches.
 */
import { canonicalBambuModelKey } from './bambu-model-keys.js'
import { withFilamentPressureAdvance } from './filament-pressure-advance.js'
import { filamentKeyWidth, filamentVariantRowsPerSlot, isFilamentVariantOption } from './variant-options.js'
import { filamentRowsBySlot, readFilamentVariantRows } from './filament-variant-rows.js'
import { filamentIdForPresetName } from './repairs/filament-ids.js'
import { filamentSettingsCatalog, filamentTransferType, FILAMENT_SETTING_KEYS, isFilamentIdentitySettingKey } from './filament-settings.js'
import { FILAMENT_PRESET_DEFAULTS, FILAMENT_PRESET_OPTIONS } from './generated/preset-options.generated.js'
import type { ProcessConfig } from './process-settings.js'
import { extractChangedFromSystemKeys, extractFilamentOverriddenKeys, filamentSlotCount, withChangedFromSystemSlot } from './three-mf-project-config.js'

/** How one filament slot rebinds on the new machine. */
export interface FilamentSlotRebind {
  /**
   * The resolved (flattened) config of the preset this slot rebinds to on the NEW machine:
   * null when no rebind target resolved, which leaves the slot's values untouched.
   */
  config: ProcessConfig | null
  /**
   * The rebound preset name persisted into `filament_settings_id`; null keeps the current name.
   *
   * Setting it also rewrites the slot's `filament_ids` entry, derived from this name. The two
   * describe one preset and BambuStudio binds on the id, so they are written together here rather
   * than asked of each caller: a caller that renamed and forgot the id is exactly how slice-time
   * preset authoring drifted them apart.
   */
  settingsId?: string | null
}

/**
 * The machine-agnostic family name of a Bambu filament preset, everything before the
 * ` @<printer>` suffix ("Bambu PETG HF @BBL X1C" -> "Bambu PETG HF"). This is the preset's
 * `alias` in BambuStudio's own profile JSONs, which its machine switch re-selects by.
 */
export function filamentPresetFamilyName(name: string): string {
  const at = name.indexOf(' @')
  return (at >= 0 ? name.slice(0, at) : name).trim()
}

/**
 * Whether a project key is a filament option a rebind may rewrite.
 *
 * The generated set is every `this->add()` in the vendored BambuStudio source, which is the same
 * authority `full_config` projects into a saved project; the catalogue is unioned in only so a key
 * the generator has not caught up with is not silently dropped from a rebind.
 */
function isRebindableFilamentKey(key: string): boolean {
  return FILAMENT_PRESET_OPTIONS.has(key) || FILAMENT_SETTING_KEYS.has(key)
}

/** A config value as strings: an array's string entries, a lone string, or nothing. */
function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => (typeof entry === 'string' ? entry : String(entry)))
  return typeof value === 'string' ? [value] : []
}

/** First string of a scalar-or-array config value; null when neither. */
function scalarAt(value: unknown, index: number): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const entry = value[index]
    return typeof entry === 'string' ? entry : null
  }
  return null
}

/**
 * Persist per-material tune-dialog overrides into a project's `project_settings.config`: the
 * save-side counterpart of the slice path's `settingOverrides` collapse ("Save in this 3MF" was
 * previously a session-only override that vanished on save/reopen). For every overridden key the
 * whole column set is written (a per-filament key's array must cover every slot): the overridden
 * slot takes the override, other slots keep their existing value, and slots with neither fall
 * back to their preset's resolved value, a key that STILL cannot cover every slot is skipped
 * whole rather than written partially (a short/blank column mis-columns every reader).
 *
 * Every written key is also appended to the slot's `different_settings_to_system` record: the
 * durable "this is a user override" marker that `rebindProjectFilamentPhysics` preserves across a
 * later machine retarget. Without the record a retarget could not tell a tune edit from a fossil
 * and would rebind it away.
 *
 * Pure; the caller (API save route) resolves `slotConfigs` with the slicer. Positions are 1-based
 * SAVED slot positions: the caller emits them post-renumber, never session ids.
 */
export function applyFilamentSlotOverrides(
  record: Record<string, unknown>,
  overridesByPosition: Record<number, ProcessConfig>,
  slotConfigs: Array<ProcessConfig | null>
): Record<string, unknown> {
  const identityCount = filamentSlotCount(record)
  if (identityCount === 0) return record
  const positions = Object.keys(overridesByPosition).map(Number).filter((position) => Number.isInteger(position) && position >= 1 && position <= identityCount)
  if (positions.length === 0) return record

  overridesByPosition = withFilamentPressureAdvance(record, overridesByPosition, slotConfigs)

  const variantRows = filamentVariantRowsPerSlot(record, identityCount)

  const next: Record<string, unknown> = { ...record }
  const recordedBySlot = new Map<number, Set<string>>()
  const overriddenKeys = new Set<string>()
  for (const position of positions) {
    for (const key of Object.keys(overridesByPosition[position] ?? {})) {
      if (FILAMENT_SETTING_KEYS.has(key) && !isFilamentIdentitySettingKey(key)) overriddenKeys.add(key)
    }
  }
  for (const key of overriddenKeys) {
    if (!variantRows && isFilamentVariantOption(key)) continue
    const existing = next[key]
    const widths = variantRows
      ? variantRows.map((rows) => filamentKeyWidth(key, rows))
      : Array.from({ length: identityCount }, () => 1)
    const offsets = widths.map((_width, slot) => widths.slice(0, slot).reduce((sum, width) => sum + width, 0))
    const columns: string[][] = []
    let complete = true
    for (let slot = 0; slot < identityCount; slot++) {
      const override = overridesByPosition[slot + 1]?.[key]
      // WIDTH PER OPTION, not one number for every key. Broadcasting every filament setting to the
      // variant count widened per-slot keys like `filament_density` to `slots x variants`, and since
      // `parseProjectFilaments` sizes the material list from the longest filament array, the project
      // reopened with N times the materials it has. See `variant-options.ts`.
      const width = widths[slot]!
      // Read the slot's OWN COLUMN VECTOR, not a single scalar. Collapsing the slot to column 0 and
      // then repeating it across the variants destroyed every later column: BambuStudio stores
      // genuinely different values per variant (`filament_max_volumetric_speed` is ["25","40"]:
      // Standard, High Flow), so the High Flow value came back rewritten to the Standard one and
      // BambuStudio reported it as the user's own change.
      const existingColumn = (variant: number): string | null =>
        (Array.isArray(existing) || typeof existing === 'string'
          ? scalarAt(existing, offsets[slot]! + variant) ?? (variant === 0 ? scalarAt(existing, slot) : null)
          : null)
      const presetValue = slotConfigs[slot]?.[key]
      const column = (variant: number): string | null =>
        scalarAt(override, variant)
          ?? existingColumn(variant)
          ?? scalarAt(presetValue, variant)
          // Only column 0 may stand in for a missing column, and only from the SAME source that
          // supplied it, never as a way to invent a variant nobody specified.
          ?? (variant === 0 ? scalarAt(override, 0) ?? scalarAt(presetValue, 0) : null)
      if (column(0) == null) {
        complete = false
        break
      }
      const built = Array.from({ length: width }, (_unused, variant) => column(variant))
      if (built.some((value) => value == null)) {
        complete = false
        break
      }
      columns.push(built as string[])
    }
    if (!complete) continue
    next[key] = columns.flat()
    for (const position of positions) {
      if (overridesByPosition[position]?.[key] == null) continue
      if (!recordedBySlot.has(position)) recordedBySlot.set(position, new Set())
      recordedBySlot.get(position)!.add(key)
    }
  }
  if (recordedBySlot.size === 0) return record

  // Append the written keys to each slot's changed-from-system record: layout
  // `[process, ...filament slots 1..N, machine]`. A short/absent record is padded to shape first.
  let updatedRecord = record.different_settings_to_system
  for (const [position, keys] of recordedBySlot) {
    // MERGED here, unlike the machine slot: a rebind adds the keys it wrote and knows nothing about
    // the rest of that slot's history, so it must not replace what it did not compute.
    const current = new Set(extractChangedFromSystemKeys(updatedRecord, position, () => true))
    for (const key of keys) current.add(key)
    updatedRecord = withChangedFromSystemSlot(updatedRecord, position, [...current], identityCount)
  }
  next.different_settings_to_system = updatedRecord
  return next
}

/**
 * The bit of a catalogue entry the rebind selection needs. Structural on purpose: `SlicingPresetSummary`
 * lives in the slicing contract module and pulling it in here would couple the pure rebind math to it.
 */
export interface FilamentRebindCandidate {
  id: string
  name: string
  /** Printer models the preset declares. Empty/absent means "judge by the name's `@<printer>` suffix". */
  printerModels?: string[] | null
}

/** Where one slot rebinds: its current preset name, and the catalogue entry it maps to (null = no move). */
export interface FilamentRebindSelection {
  slotName: string
  target: FilamentRebindCandidate | null
}

/**
 * Choose where each filament slot rebinds on the target machine, mirroring BambuStudio's alias
 * re-selection: the slot's exact preset when it is still compatible, else the same FAMILY's variant
 * for that machine (preferring one matching the target machine preset's nozzle token), else nothing
 * (the slot keeps its values).
 *
 * Pure selection only: resolving each chosen preset's CONFIG is the caller's job, because the two
 * hosts reach it differently (the api through the slicer + its workspace preset files, the browser
 * through the anonymous resolve endpoint). Returns null when the record has no usable slot list,
 * which callers treat as "nothing to rebind".
 *
 * `candidates` must already be filtered to filament presets, ordered most-preferred first (custom
 * before builtin), exactly as the pickers order them.
 */
export function selectFilamentRebindTargets(input: {
  /** The retargeted record's `filament_settings_id`. */
  filamentSettingsIds: unknown
  candidates: readonly FilamentRebindCandidate[]
  /** Canonical model key of the target machine (see `canonicalBambuModelKey`). */
  targetModelKey: string
  /** The target machine preset name; its nozzle token breaks family-variant ties. */
  nozzleHint: string
}): FilamentRebindSelection[] | null {
  const raw = input.filamentSettingsIds
  if (!Array.isArray(raw)) return null
  const names = raw.filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
  // A partly-blank slot list means the record is not describing its filaments the way the rebind
  // assumes; mis-columning it is worse than skipping the improvement pass.
  if (names.length === 0 || names.length !== raw.length) return null
  if (input.candidates.length === 0) return null

  const compatible = (candidate: FilamentRebindCandidate): boolean => {
    if (candidate.printerModels && candidate.printerModels.length > 0) {
      return candidate.printerModels.some((model) => canonicalBambuModelKey(model) === input.targetModelKey)
    }
    // No declared models: judge by the name's own `@<printer>` suffix; a suffix-less preset
    // ("Generic PLA") is machine-agnostic and always eligible.
    const at = candidate.name.indexOf(' @')
    if (at < 0) return true
    const suffix = candidate.name.slice(at + 2).replace(/^BBL\s+/i, '').replace(/\s+\d+(?:\.\d+)?\s*nozzle.*$/i, '')
    return canonicalBambuModelKey(suffix) === input.targetModelKey
  }
  const nozzleToken = input.nozzleHint.match(/\d+(?:\.\d+)?\s*nozzle/i)?.[0]?.toLowerCase() ?? null

  return names.map((slotName) => {
    const exact = input.candidates.find((candidate) => candidate.name === slotName)
    if (exact && compatible(exact)) return { slotName, target: exact }
    const family = filamentPresetFamilyName(slotName)
    const familyCandidates = input.candidates.filter(
      (candidate) => filamentPresetFamilyName(candidate.name) === family && compatible(candidate)
    )
    const target = (nozzleToken ? familyCandidates.find((candidate) => candidate.name.toLowerCase().includes(nozzleToken)) : undefined)
      ?? familyCandidates[0]
      ?? null
    return { slotName, target }
  })
}

export function rebindProjectFilamentPhysics(
  record: Record<string, unknown>,
  slots: FilamentSlotRebind[]
): Record<string, unknown> {
  const identityCount = filamentSlotCount(record)
  // Defensive: the caller derives `slots` from the same record, so a mismatch means the record
  // changed underneath: leave it alone rather than mis-column it.
  if (identityCount === 0 || slots.length !== identityCount) return record
  if (slots.every((slot) => slot.config == null && slot.settingsId == null)) return record

  // The rows the PROJECT declares, per slot. Not a uniform width: a TPU slot owns more rows than
  // its neighbours, and dividing pretended otherwise (a PLA + TPU rebind onto an H2D wrote a 6-row
  // variant list under a 7-row index, which Bambu Studio refuses to open). Null when the rows
  // cannot be attributed; variant-scoped keys then fall back to the stored stride below.
  const rows = readFilamentVariantRows(record, identityCount)
  const rowsBySlot = rows ? filamentRowsBySlot(rows, identityCount) : null
  // A slot renamed to a different MATERIAL keeps none of its recorded edits: Bambu Studio never
  // transfers a filament preset's changes across a raw `filament_type` change (`Tab::select_preset`
  // sets `no_transfer`). Honouring the old record kept a PLA slot's 230 C on the PETG it became.
  const recordedTypes = Array.isArray(record.filament_type) ? record.filament_type : []
  const changesMaterial = slots.map((slot, index) => {
    if (!slot.settingsId || !slot.config) return false
    const before = filamentTransferType(scalarAt(recordedTypes, index))
    const after = filamentTransferType(scalarAt(slot.config.filament_type, 0))
    return Boolean(before && after && before !== after)
  })
  const overriddenBySlot = slots.map((_slot, index) => (changesMaterial[index]
    ? new Set<string>()
    : new Set(extractFilamentOverriddenKeys(record.different_settings_to_system, index + 1))))

  const next: Record<string, unknown> = { ...record }
  // The record goes with the edits it described, or the next reader would take the new
  // material's preset values for the user's own changes.
  if (changesMaterial.some(Boolean) && Array.isArray(record.different_settings_to_system)) {
    let changedFromSystem: unknown = record.different_settings_to_system
    changesMaterial.forEach((changes, index) => {
      if (changes) changedFromSystem = withChangedFromSystemSlot(changedFromSystem, index + 1, [], identityCount)
    })
    next.different_settings_to_system = changedFromSystem
  }
  for (const key of Object.keys(record)) {
    // Gated on every filament option BambuStudio DECLARES, not on the tune dialog's catalogue.
    // The catalogue is scoped to what that dialog exposes, and the keys it omits are exactly the
    // ones this pass kept missing: a PLA project sliced as PETG rebound its name, id and
    // temperatures but left `filament_dev_ams_drying_temperature` at PLA's 45 under a PETG name,
    // because the drying block is not a dialog setting. Same trap the default lookup below already
    // hit (`filament_extruder_compatibility`), and the same one `bambu-preset-codec.ts` documents.
    // The union keeps any catalogue key the vendored generator has not caught up with.
    if (!isRebindableFilamentKey(key) || isFilamentIdentitySettingKey(key)) continue
    // The layout's own columns belong to the MACHINE retarget, which built them for the new
    // machine. `filament_extruder_variant` is itself a variant-scoped filament option, so treating
    // it as physics rewrote the layout at a guessed width and broke it against the index.
    if (key === 'filament_extruder_variant' || key === 'filament_self_index') continue
    const value = record[key]
    if (typeof value !== 'string' && !Array.isArray(value)) continue
    // Which rows this key has, from BambuStudio's per-option rule, never from one number applied
    // to every key: a per-slot key at variant width made a 3-material project reopen with 6.
    const variantScoped = isFilamentVariantOption(key)
    const layoutRows = variantScoped && rowsBySlot && rows ? rows : null
    const fitsLayout = layoutRows != null && Array.isArray(value) && value.length === layoutRows.length
    // Fallback stride for a value that does not match the declared rows (a save from before the
    // layout rule). Used only to READ; the output always takes the declared rows.
    const storedWidth = Array.isArray(value) && identityCount > 0 && value.length % identityCount === 0
      ? value.length / identityCount
      : 1
    /** The variant names a slot's output rows carry (one unnamed row for a per-slot key). */
    const targetVariants = (slot: number): Array<string | null> => layoutRows
      ? rowsBySlot![slot]!.map((row) => layoutRows[row]!.variant)
      : [null]
    /** The stored value for a slot's `position`-th row, read at the rows the record declares. */
    const storedAt = (slot: number, position: number): string | null => {
      if (fitsLayout) {
        const row = rowsBySlot![slot]![position]
        return row == null ? null : scalarAt(value, row)
      }
      return position < storedWidth ? scalarAt(value, slot * storedWidth + position) : null
    }
    const columns: string[][] = []
    let anyColumn = false
    for (let slot = 0; slot < identityCount; slot++) {
      const variants = targetVariants(slot)
      const width = variants.length
      const oldScalar = storedAt(slot, 0) ?? scalarAt(value, slot) ?? scalarAt(value, 0)
      const presetValue = slots[slot]?.config?.[key]
      const presetVariants = stringList(slots[slot]?.config?.filament_extruder_variant)
      /**
       * The preset's own value for an output row, by variant name, else by position. Null when the
       * preset does not spell that column out, so the caller can keep the project's column first.
       */
      const presetAt = (variant: number): string | null => {
        const name = variants[variant]
        const byName = name != null ? presetVariants.indexOf(name) : -1
        return scalarAt(presetValue, byName >= 0 ? byName : variant)
      }
      let slotColumns: string[] | null
      if (overriddenBySlot[slot]!.has(key)) {
        // Genuine user override: survives the machine switch, PER COLUMN. It used to take the
        // slot's first column and repeat it across the variants, which silently rewrote every later
        // variant to the first one: a slot that declared `filament_max_volumetric_speed` as changed
        // came back ["25","25"] where BambuStudio had ["25","40"] (Standard, High Flow), and
        // BambuStudio reported the High Flow value as the user's own edit. Keep each column the file
        // actually holds; only a column the file lacks falls back to its first.
        slotColumns = oldScalar != null
          ? Array.from({ length: width }, (_unused, variant) => storedAt(slot, variant) ?? oldScalar)
          : null
      } else if (presetValue != null) {
        // Rebind to the new variant's value. Preset arrays already carry per-variant columns.
        // Per COLUMN, and never by repeating column 0. The variants genuinely differ,
        // BambuStudio writes `filament_max_volumetric_speed: ["25","40"]` (Standard, High Flow),
        // so a preset that spells out only the first column used to overwrite High Flow with the
        // Standard value, and BambuStudio then reported it as the user's own change on a project
        // that had merely been re-saved. A column the preset does not supply keeps what the PROJECT
        // already had; only if the file has nothing either does the preset's first column stand in.
        slotColumns = Array.from({ length: width }, (_unused, variant) =>
          presetAt(variant)
            ?? storedAt(slot, variant)
            ?? scalarAt(presetValue, 0)
            ?? '')
      } else {
        // The new preset does not define the key, so the slot takes the OPTION'S DEFAULT, which is
        // what BambuStudio itself stores for an unset value (its own save has
        // `pressure_advance: ["0.02","0.02","0.02"]`, `ironing_fan_speed: ["-1","-1","-1"]`).
        //
        // This used to DROP the key instead, reasoning that absence equals the preset default at
        // load. It does not: BambuStudio reads a missing filament key as a deviation and mints a
        // `(<project>.3mf)` preset rather than binding the user's own. MEASURED: nine keys the
        // resolver never returns were written by the repair and deleted again here, and the slot
        // would not bind until they survived. Filling with the DEFAULT rather than keeping the old
        // value preserves what dropping was actually for: the previous material's physics still
        // must not linger after a material change.
        // WHICH absence is this? A slot with NO config at all was never touched, the caller is
        // re-authoring a sibling, and its values must stand: "a save must not quietly normalise
        // settings the user did not touch" is a load-bearing invariant, pinned by
        // `bake-documents.filamentSettingsId.test.ts`. Only a slot that HAS a config (its material
        // changed) and simply lacks this key falls to the option default, so the previous material's
        // number cannot follow the new one.
        if (slots[slot]?.config == null) {
          slotColumns = oldScalar != null
            ? Array.from({ length: width }, (_unused, variant) => storedAt(slot, variant) ?? oldScalar)
            : null
        } else {
          // Same default source as the authoring pass: BambuStudio's PrintConfig default for the
          // option, falling back to the tune dialog's narrower catalogue. Using only the catalogue
          // here left preset options it does not list (`filament_extruder_compatibility`) with an
          // empty value, which the drop-vote below then discarded entirely.
          const fallback = FILAMENT_PRESET_DEFAULTS[key] ?? filamentSettingsCatalog.options[key]?.default ?? ''
          slotColumns = Array.from({ length: width }, () => fallback)
        }
      }
      if (slotColumns == null) {
        // A key's array must cover every slot; one unresolvable slot keeps its old value only
        // when another slot's override forces the key to stay (handled below via anyColumn).
        slotColumns = oldScalar != null ? Array.from({ length: width }, () => oldScalar) : Array.from({ length: width }, () => '')
      } else {
        anyColumn = true
      }
      columns.push(slotColumns)
    }
    if (!anyColumn) {
      // No slot has a preset value or an override for this key: drop it wholesale.
      delete next[key]
      continue
    }
    // Assembled in LAYOUT order: the index, not slot order, says where each row sits.
    if (layoutRows) {
      const taken = Array.from({ length: identityCount }, () => 0)
      next[key] = layoutRows.map((row) => columns[row.slot]![taken[row.slot]!++] ?? '')
    } else {
      next[key] = columns.flat()
    }
  }

  // The MATERIAL is the third part of the same fact as the name and the id below, so all three move
  // together or none do. Left behind, it made a slice that changed material hand the engine a
  // project naming `Generic PETG` while typed `PLA`: the physics rebound, the type did not, and only
  // the command-line preset file kept the print honest, so a re-slice of the preserved project got
  // PETG-as-PLA.
  //
  // Gated on the RENAME, not on the config. A caller may supply a config without a `settingsId`
  // (the browser retarget flattens a workspace preset the slot already names, to rebind its physics
  // for the new machine) and that slot is not changing material: writing its type from the config
  // while the name and id stay put is precisely the disagreement this exists to prevent, and one
  // BambuStudio answers by fabricating a defaults-only `(<project>.3mf)` preset.
  const types = Array.isArray(record.filament_type) ? [...record.filament_type] : null
  if (types && types.length === identityCount) {
    let renamedAny = false
    slots.forEach((slot, index) => {
      if (!slot.settingsId) return
      const presetType = scalarAt(slot.config?.filament_type, 0)
      if (presetType) {
        types[index] = presetType
        renamedAny = true
      }
    })
    if (renamedAny) next.filament_type = types
  }

  const settingsIds = Array.isArray(record.filament_settings_id) ? [...record.filament_settings_id] : null
  if (settingsIds) {
    // The NAME and the ID are one fact about a slot, so they are written together, here, from the
    // same input. BambuStudio binds a slot on `filament_ids` and shows `filament_settings_id`, so a
    // slot reading "Bambu PLA Basic" while carrying PETG's `GFG02` makes it fabricate a
    // defaults-only `(<project>.3mf)` preset instead of opening the material.
    //
    // They used to have two producers: this function renamed and never touched the id, so slice-time
    // preset authoring drifted them apart in the very project it hands the engine and preserves for
    // "Slice again". Deriving the id here rather than taking it from the caller is what makes the
    // drift inexpressible for the next caller too.
    const ids = Array.isArray(record.filament_ids) ? record.filament_ids.map((entry) => (typeof entry === 'string' ? entry : '')) : null
    slots.forEach((slot, index) => {
      if (!slot.settingsId) return
      settingsIds[index] = slot.settingsId
      // Only a RENAME owns the id. An unknown preset writes EMPTY, which is what BambuStudio writes
      // for an id it does not recognise; keeping the old one would be a confident lie about which
      // material the slot is, and that lie is the whole defect.
      if (ids) ids[index] = filamentIdForPresetName(slot.settingsId) ?? ''
    })
    next.filament_settings_id = settingsIds
    if (ids) next.filament_ids = ids
  }
  return next
}
