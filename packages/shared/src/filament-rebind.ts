/**
 * Filament-physics REBIND for a machine retarget — the data half of BambuStudio's machine-switch
 * semantics. When BambuStudio switches printers, `PresetBundle::update_compatible` re-selects
 * every filament preset by ALIAS (the machine-agnostic family name, "Bambu PETG HF") with top
 * priority, so the effective per-filament values become the NEW machine variant's; only the
 * user's own recorded overrides survive. Our save-side retarget rewrote the machine topology but
 * carried the per-filament numeric columns forward verbatim, leaving the OLD variant's values
 * baked under the new machine — "fossils" that read as phantom "changed vs preset" markers ever
 * after (production case: X1C's engine-default `pre_start_fan_time` 0 flagged against H2D's
 * stock 2 forever).
 *
 * Contract:
 * - Only keys PRESENT in the record are rewritten. An absent key already means "the preset's
 *   value at load", which re-derives for the new machine on its own — writing it would only
 *   grow the file.
 * - A slot's key recorded in `different_settings_to_system` is a genuine user override: its OLD
 *   value is preserved (broadcast to the new variant width), never replaced by the preset.
 * - A present key the new preset does not define drops for non-overridden slots (absence =
 *   preset default) — kept only while some slot's override needs the column to exist.
 * - Column layout follows the RETARGETED record: `filaments x variants`, the variant width read
 *   from `filament_extruder_variant` (which the machine retarget has already rebuilt for the new
 *   machine). Old values are read variant-aware from whatever width they had.
 *
 * Pure — a parsed record + resolved preset configs in, a new record out. The API resolves the
 * rebind targets (name/alias matching + the slicer's profile resolver) in
 * `apps/api/src/lib/save-retarget.ts`; this module never fetches.
 */
import { canonicalBambuModelKey } from './bambu-model-keys.js'
import { FILAMENT_SETTING_KEYS, isFilamentIdentitySettingKey } from './filament-settings.js'
import type { ProcessConfig } from './process-settings.js'
import { extractFilamentOverriddenKeys } from './three-mf-project-config.js'

/** How one filament slot rebinds on the new machine. */
export interface FilamentSlotRebind {
  /**
   * The resolved (flattened) config of the preset this slot rebinds to on the NEW machine —
   * null when no rebind target resolved, which leaves the slot's values untouched.
   */
  config: ProcessConfig | null
  /** The rebound preset name persisted into `filament_settings_id`; null keeps the current name. */
  settingsId?: string | null
}

/**
 * The machine-agnostic family name of a Bambu filament preset — everything before the
 * ` @<printer>` suffix ("Bambu PETG HF @BBL X1C" -> "Bambu PETG HF"). This is the preset's
 * `alias` in BambuStudio's own profile JSONs, which its machine switch re-selects by.
 */
export function filamentPresetFamilyName(name: string): string {
  const at = name.indexOf(' @')
  return (at >= 0 ? name.slice(0, at) : name).trim()
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
 * Persist per-material tune-dialog overrides into a project's `project_settings.config` — the
 * save-side counterpart of the slice path's `settingOverrides` collapse ("Save in this 3MF" was
 * previously a session-only override that vanished on save/reopen). For every overridden key the
 * whole column set is written (a per-filament key's array must cover every slot): the overridden
 * slot takes the override, other slots keep their existing value, and slots with neither fall
 * back to their preset's resolved value — a key that STILL cannot cover every slot is skipped
 * whole rather than written partially (a short/blank column mis-columns every reader).
 *
 * Every written key is also appended to the slot's `different_settings_to_system` record — the
 * durable "this is a user override" marker that `rebindProjectFilamentPhysics` preserves across a
 * later machine retarget. Without the record a retarget could not tell a tune edit from a fossil
 * and would rebind it away.
 *
 * Pure; the caller (API save route) resolves `slotConfigs` with the slicer. Positions are 1-based
 * SAVED slot positions — the caller emits them post-renumber, never session ids.
 */
export function applyFilamentSlotOverrides(
  record: Record<string, unknown>,
  overridesByPosition: Record<number, ProcessConfig>,
  slotConfigs: Array<ProcessConfig | null>
): Record<string, unknown> {
  const identityCount = Math.max(
    Array.isArray(record.filament_settings_id) ? record.filament_settings_id.length : 0,
    Array.isArray(record.filament_colour) ? record.filament_colour.length : 0,
    Array.isArray(record.filament_type) ? record.filament_type.length : 0
  )
  if (identityCount === 0) return record
  const positions = Object.keys(overridesByPosition).map(Number).filter((position) => Number.isInteger(position) && position >= 1 && position <= identityCount)
  if (positions.length === 0) return record

  const variantColumns = Array.isArray(record.filament_extruder_variant) ? record.filament_extruder_variant.length : 0
  const variantCount = variantColumns > identityCount && variantColumns % identityCount === 0
    ? variantColumns / identityCount
    : 1

  const next: Record<string, unknown> = { ...record }
  const recordedBySlot = new Map<number, Set<string>>()
  const overriddenKeys = new Set<string>()
  for (const position of positions) {
    for (const key of Object.keys(overridesByPosition[position] ?? {})) {
      if (FILAMENT_SETTING_KEYS.has(key) && !isFilamentIdentitySettingKey(key)) overriddenKeys.add(key)
    }
  }
  for (const key of overriddenKeys) {
    const existing = next[key]
    const oldWidth = Array.isArray(existing) && existing.length % identityCount === 0 ? existing.length / identityCount : 1
    const columns: string[][] = []
    let complete = true
    for (let slot = 0; slot < identityCount; slot++) {
      const override = overridesByPosition[slot + 1]?.[key]
      const source = override
        ?? (Array.isArray(existing) || typeof existing === 'string'
          ? scalarAt(existing, slot * oldWidth) ?? scalarAt(existing, slot)
          : null)
        ?? slotConfigs[slot]?.[key]
        ?? null
      if (source == null) {
        complete = false
        break
      }
      columns.push(Array.from({ length: variantCount }, (_unused, variant) => scalarAt(source, variant) ?? scalarAt(source, 0) ?? ''))
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
  const existingRecord = Array.isArray(record.different_settings_to_system)
    ? record.different_settings_to_system.map((entry) => (typeof entry === 'string' ? entry : ''))
    : []
  while (existingRecord.length < identityCount + 2) existingRecord.push('')
  for (const [position, keys] of recordedBySlot) {
    const current = new Set((existingRecord[position] ?? '').split(';').map((key) => key.trim()).filter(Boolean))
    for (const key of keys) current.add(key)
    existingRecord[position] = [...current].join(';')
  }
  next.different_settings_to_system = existingRecord
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
 * Pure selection only — resolving each chosen preset's CONFIG is the caller's job, because the two
 * hosts reach it differently (the api through the slicer + its tenant preset files, the browser
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
  const identityCount = Math.max(
    Array.isArray(record.filament_settings_id) ? record.filament_settings_id.length : 0,
    Array.isArray(record.filament_colour) ? record.filament_colour.length : 0,
    Array.isArray(record.filament_type) ? record.filament_type.length : 0
  )
  // Defensive: the caller derives `slots` from the same record, so a mismatch means the record
  // changed underneath — leave it alone rather than mis-column it.
  if (identityCount === 0 || slots.length !== identityCount) return record
  if (slots.every((slot) => slot.config == null && slot.settingsId == null)) return record

  const variantColumns = Array.isArray(record.filament_extruder_variant) ? record.filament_extruder_variant.length : 0
  const variantCount = variantColumns > identityCount && variantColumns % identityCount === 0
    ? variantColumns / identityCount
    : 1
  const overriddenBySlot = slots.map((_slot, index) => new Set(extractFilamentOverriddenKeys(record.different_settings_to_system, index + 1)))

  const next: Record<string, unknown> = { ...record }
  for (const key of Object.keys(record)) {
    if (!FILAMENT_SETTING_KEYS.has(key) || isFilamentIdentitySettingKey(key)) continue
    const value = record[key]
    if (typeof value !== 'string' && !Array.isArray(value)) continue
    // The old per-slot scalar, read variant-aware from whatever width the value has now.
    const oldWidth = Array.isArray(value) && identityCount > 0 && value.length % identityCount === 0
      ? value.length / identityCount
      : 1
    const columns: string[][] = []
    let anyColumn = false
    for (let slot = 0; slot < identityCount; slot++) {
      const oldScalar = scalarAt(value, slot * oldWidth) ?? scalarAt(value, slot) ?? scalarAt(value, 0)
      const presetValue = slots[slot]?.config?.[key]
      let slotColumns: string[] | null
      if (overriddenBySlot[slot]!.has(key)) {
        // Genuine user override — survives the machine switch, broadcast to the new width.
        slotColumns = oldScalar != null ? Array.from({ length: variantCount }, () => oldScalar) : null
      } else if (presetValue != null) {
        // Rebind to the new variant's value. Preset arrays already carry per-variant columns.
        slotColumns = Array.from({ length: variantCount }, (_unused, variant) =>
          scalarAt(presetValue, variant) ?? scalarAt(presetValue, 0) ?? '')
      } else {
        // The new preset does not define the key and nothing overrides it: absence is the
        // correct state (preset default at load) — vote to drop the whole column set.
        slotColumns = null
      }
      if (slotColumns == null) {
        // A key's array must cover every slot; one unresolvable slot keeps its old value only
        // when another slot's override forces the key to stay (handled below via anyColumn).
        slotColumns = oldScalar != null ? Array.from({ length: variantCount }, () => oldScalar) : Array.from({ length: variantCount }, () => '')
      } else {
        anyColumn = true
      }
      columns.push(slotColumns)
    }
    if (!anyColumn) {
      // No slot has a preset value or an override for this key — drop it wholesale.
      delete next[key]
      continue
    }
    next[key] = columns.flat()
  }

  const settingsIds = Array.isArray(record.filament_settings_id) ? [...record.filament_settings_id] : null
  if (settingsIds) {
    slots.forEach((slot, index) => {
      if (slot.settingsId) settingsIds[index] = slot.settingsId
    })
    next.filament_settings_id = settingsIds
  }
  return next
}
