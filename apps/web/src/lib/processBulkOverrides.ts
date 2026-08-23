/**
 * Bulk (multi-target) per-object/per-part process-override editing: how one settings dialog
 * opened for SEVERAL objects or parts seeds a single form from their individual override maps,
 * and how the dialog's result is applied back to each member without clobbering values the user
 * never touched. `ProcessSettingsDialog` consumes the seed/result halves; the editor's bulk
 * apply consumes the merge half.
 *
 * Contract:
 * - a key set on EVERY member with the same value is UNIFORM: the form shows that value, and an
 *   edit or reset applies to every member;
 * - a key set on only some members, or set with differing values, is MIXED: the form shows an
 *   explicit "Mixed" state; untouched it preserves each member's own value, edited it becomes one
 *   uniform value for all, reset it is cleared from every member;
 * - value equality is option-aware (`processConfigValuesEqual` with the catalog option), so
 *   serialization variants of one value ("45.0" vs "45%") never read as mixed.
 *
 * A single member degenerates to exact seeding (every key uniform), so the same code path serves
 * the single-object dialog unchanged.
 */
import {
  processConfigValuesEqual,
  processSettingsCatalog,
  type ProcessSettingOverrides
} from '@printstream/shared'

/** What a bulk dialog seeds its form state from. */
export interface BulkOverridesSeed {
  /** Keys explicitly set on at least one member (the dialog's "set" markers). */
  explicitKeys: Set<string>
  /** The subset of `explicitKeys` the members disagree on (shown as "Mixed"). */
  mixedKeys: Set<string>
  /** The agreed value for each explicit, non-mixed key (layered over the inherited config). */
  uniformOverrides: ProcessSettingOverrides
}

/** What a bulk dialog emits on apply, to be merged onto each member. */
export interface BulkOverridesResult {
  /** Uniform final values: set on every member. */
  overrides: ProcessSettingOverrides
  /** Keys the user reset: removed from every member. Untouched mixed keys appear in neither. */
  clearedKeys: string[]
}

/**
 * Classifies each key across the members' override maps. Explicitness is part of the state, not
 * just the value: a key set on only SOME members is mixed even when the set values agree, because
 * the members without it carry no pin to compare (per-object overrides pin a value against later
 * global changes even when it currently matches).
 */
export function summarizeBulkOverrides(members: ReadonlyArray<ProcessSettingOverrides>): BulkOverridesSeed {
  const explicitKeys = new Set<string>()
  for (const member of members) {
    for (const key of Object.keys(member)) explicitKeys.add(key)
  }
  const mixedKeys = new Set<string>()
  const uniformOverrides: ProcessSettingOverrides = {}
  for (const key of explicitKeys) {
    const values = members.map((member) => member[key])
    const first = values[0]
    if (first === undefined || values.some((value) => value === undefined)) {
      mixedKeys.add(key)
      continue
    }
    const option = processSettingsCatalog.options[key]
    if (values.every((value) => processConfigValuesEqual(first, value, option))) {
      uniformOverrides[key] = first
    } else {
      mixedKeys.add(key)
    }
  }
  return { explicitKeys, mixedKeys, uniformOverrides }
}

/**
 * The apply-time counterpart of {@link summarizeBulkOverrides}: turns the dialog's final form
 * state into the uniform overrides + cleared keys to merge onto each member. Keys still mixed are
 * deliberately in neither set, which is what preserves each member's own value.
 *
 * `initialSetKeys` is the explicit-key set AT LOAD (the union across members): any of those keys
 * no longer explicit was reset by the user and must be cleared everywhere.
 */
export function collectBulkOverridesResult(input: {
  config: Readonly<Record<string, string | string[]>>
  explicitKeys: ReadonlySet<string>
  mixedKeys: ReadonlySet<string>
  initialSetKeys: ReadonlySet<string>
}): BulkOverridesResult {
  const overrides: ProcessSettingOverrides = {}
  for (const key of input.explicitKeys) {
    if (input.mixedKeys.has(key)) continue
    const value = input.config[key]
    if (value !== undefined) overrides[key] = value
  }
  return {
    overrides,
    clearedKeys: [...input.initialSetKeys].filter((key) => !input.explicitKeys.has(key))
  }
}

/**
 * Merges a bulk result onto one member's existing override map. Pure; returns a new map (possibly
 * empty: whether an empty map is kept or deleted is the caller's storage convention).
 *
 * Generic over the value type because object overrides store `string | string[]` while part
 * overrides store pre-serialized `string`s.
 */
export function applyBulkOverridesToMember<Value>(
  existing: Readonly<Record<string, Value>> | undefined,
  overrides: Readonly<Record<string, Value>>,
  clearedKeys: ReadonlyArray<string>
): Record<string, Value> {
  const merged: Record<string, Value> = { ...(existing ?? {}) }
  for (const key of clearedKeys) delete merged[key]
  for (const [key, value] of Object.entries(overrides)) merged[key] = value
  return merged
}
