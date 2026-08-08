/**
 * The invariant that a project's `filament_ids[i]` names the SAME material as its
 * `filament_settings_id[i]`, plus a conservative repair for files that break it.
 *
 * OWNS: detecting and fixing an id/name contradiction in a stored `project_settings.config`.
 *
 * WHY IT MATTERS: BambuStudio BINDS a filament slot on the id, not the name. It builds both arrays as
 * parallel projections of one selected-preset list (`PresetBundle`: `filament_settings_id` from
 * `preset.name`, `filament_ids` from `preset.filament_id`), so its own files cannot disagree. Ours
 * could: `filament_ids` used to be carried positionally from the slot a material came FROM, so
 * switching a project's material left the old material's id under the new name. BambuStudio cannot
 * reconcile the two, so it fabricates a defaults-only project preset per slot named
 * `(<project>.3mf)` — the slot then carries neither the material's real physics nor a usable
 * identity. Seen on a real ABS project switched to PETG: `["GFB00","GFB00","GFS06"]` (ABS, ABS,
 * Support for ABS) beside names reading PETG HF and PLA Basic.
 *
 * The save path no longer produces this (the bake authors `filament_ids` from the chosen presets).
 * This module exists for files ALREADY saved with it, which do not heal at rest — see the contract
 * in `repairs/index.ts`: repairing is an explicit user action, staged in the editor.
 *
 * CONSERVATIVE BY CONSTRUCTION, and this is the point: a slot is only corrected when its preset name
 * resolves to a catalogue id EXACTLY. An unresolvable name (a custom or third-party preset) is left
 * untouched and reported, never guessed at — inventing a plausible-looking id is precisely the
 * failure this repairs, and a heuristic that strips custom suffixes to find a "close" match would
 * reintroduce it. Callers surface the unresolved slots so the user knows the repair was partial.
 */
import { BAMBU_FILAMENT_PRESET_NAMES } from '../bambu-filament-presets.js'

/** One slot's verdict. */
export interface FilamentIdSlotInspection {
  /** 0-based slot index. */
  index: number
  /** The id the file carries (`''` when absent). */
  currentId: string
  /** The catalogue material that id denotes, or null when the id is unknown to us. */
  currentMaterial: string | null
  /** The preset name the slot claims. */
  presetName: string
  /** The id that name resolves to, or null when the catalogue cannot match it exactly. */
  expectedId: string | null
}

export interface FilamentIdInspection {
  /** True when at least one slot's id contradicts its name AND the correct id is known. */
  inconsistent: boolean
  /** Slots whose id contradicts their name and CAN be corrected. */
  repairable: FilamentIdSlotInspection[]
  /**
   * Slots whose id contradicts their name but whose preset the catalogue cannot match, so the
   * correct id is unknown. Left alone by the repair; surfaced so the user is told it was partial.
   */
  unresolved: FilamentIdSlotInspection[]
}

/**
 * The material a preset name denotes, with BambuStudio's compatibility suffix removed.
 *
 * `Bambu PETG HF @BBL H2D 0.4 nozzle` -> `Bambu PETG HF`. The `@<machine>` part is a compatibility
 * tag rather than part of the material's name, and everything after it (` - 55 degree plate`, the
 * nozzle size) qualifies the machine, not the filament — which is why truncating at the FIRST `@`
 * is right and reproduces the id BambuStudio itself writes.
 */
export function filamentPresetBaseName(presetName: string): string {
  const at = presetName.indexOf('@')
  return (at === -1 ? presetName : presetName.slice(0, at)).trim()
}

/** Catalogue id for a preset name, or null when nothing matches it exactly. */
export function filamentIdForPresetName(presetName: string): string | null {
  const base = filamentPresetBaseName(presetName)
  if (!base) return null
  for (const [id, name] of Object.entries(BAMBU_FILAMENT_PRESET_NAMES)) {
    if (name === base) return id
  }
  return null
}

function stringArrayAt(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.map((entry) => (typeof entry === 'string' ? entry : ''))
}

/**
 * Inspect a project's filament id/name agreement.
 *
 * Returns null when there is nothing to judge (unparseable settings, or no filament arrays) — those
 * files are not affected, as distinct from "inspected and consistent".
 *
 * A slot counts as contradictory only when BOTH ids are known and DIFFER. An absent or empty
 * `filament_ids` entry is not a contradiction: BambuStudio writes an empty entry for a preset that
 * declares no id, so an empty value is a truthful "unknown" rather than a wrong claim.
 */
export function inspectProjectFilamentIds(
  projectSettingsJson: string | null | undefined
): FilamentIdInspection | null {
  if (!projectSettingsJson) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>

  const names = stringArrayAt(record.filament_settings_id)
  const ids = stringArrayAt(record.filament_ids)
  if (!names || !ids || names.length === 0) return null

  const repairable: FilamentIdSlotInspection[] = []
  const unresolved: FilamentIdSlotInspection[] = []
  for (const [index, presetName] of names.entries()) {
    const currentId = ids[index] ?? ''
    // Empty is an honest "unknown", not a contradiction — nothing to repair.
    if (currentId === '') continue
    const expectedId = filamentIdForPresetName(presetName)
    if (expectedId === currentId) continue
    const slot: FilamentIdSlotInspection = {
      index,
      currentId,
      currentMaterial: BAMBU_FILAMENT_PRESET_NAMES[currentId] ?? null,
      presetName,
      expectedId
    }
    if (expectedId === null) unresolved.push(slot)
    else repairable.push(slot)
  }

  return { inconsistent: repairable.length > 0, repairable, unresolved }
}

/**
 * Rewrite the resolvable slots' ids in place on a parsed settings record.
 *
 * Returns the slots it changed. Slots in {@link FilamentIdInspection.unresolved} are deliberately
 * left as they are — see the module header. A no-op returns an empty array and leaves `record`
 * untouched, so callers can decide not to persist anything.
 */
export function repairFilamentIds(record: Record<string, unknown>): FilamentIdSlotInspection[] {
  const inspection = inspectProjectFilamentIds(JSON.stringify(record))
  if (!inspection || inspection.repairable.length === 0) return []
  const ids = stringArrayAt(record.filament_ids)
  if (!ids) return []
  const next = [...ids]
  for (const slot of inspection.repairable) {
    if (slot.expectedId === null) continue
    next[slot.index] = slot.expectedId
  }
  record.filament_ids = next
  return inspection.repairable
}
