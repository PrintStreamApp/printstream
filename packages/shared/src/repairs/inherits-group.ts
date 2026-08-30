/**
 * The `inherits_group` width invariant for Bambu `project_settings.config`.
 *
 * OWNS the rule that `inherits_group` is `[process, ...one entry per filament slot, machine]`, so
 * its length must be `filaments + 2`. The MACHINE entry sits at the END, which is what makes a
 * stale width dangerous rather than merely untidy: the extra entries do not sit harmlessly on the
 * tail, they displace what the CLI reads as the machine.
 *
 * WHY IT IS FATAL. `BambuStudio.cpp` sizes its filament-name vector from THIS array and then
 * indexes the filament names with it, unguarded:
 *
 *     current_filaments_system_name.resize(size - 2);          // size = inherits_group.size()
 *     for (int index = 1; index < (size - 1); index++)
 *         current_filaments_system_name[index-1] = current_filaments_name[index-1];
 *
 * `current_filaments_name` comes from `filament_settings_id`, so an `inherits_group` describing
 * MORE slots than the project actually has reads past the end of the filament names: SIGSEGV
 * while LOADING the project, before slicing starts, surfacing as an opaque exit 139 that the
 * crash classifier then retries three times. Observed in production on a project taken from 5
 * filaments to 1 whose `inherits_group` kept all 7 entries.
 *
 * The authoring side is fixed (`applyFilamentList` rebuilds this beside its twin
 * `different_settings_to_system`), so a re-save heals a file. This module is for the ones ALREADY
 * saved, which stay fatal until repaired.
 *
 * Counterparts: `flush-volumes-matrix.ts` and `filament-variant-index.ts` own the sibling sizing
 * invariants. Detection and repair share one implementation here so a file cannot be flagged by
 * one and left untouched by the other.
 */
import { filamentSlotCount } from '../three-mf-project-config.js'

/** What a project's stored `inherits_group` looks like next to the width its filament set requires. */
export interface InheritsGroupInspection {
  /** Entries the project stores. */
  actualLength: number
  /** Entries its filament count requires (`filaments + 2`). */
  expectedLength: number
  filamentCount: number
  inconsistent: boolean
  /**
   * Whether a correct replacement can be produced. False means "broken but not safely fixable":
   * surfaced rather than hidden, because a defect flagged to the user and then silently skipped by
   * the repair is indistinguishable from a repair that failed.
   */
  repairable: boolean
}

/**
 * Bring `inherits_group` back to `filaments + 2`, preserving the process entry (first) and the
 * machine entry (LAST, it moves when the count changes) and keeping each surviving slot's parent.
 *
 * @returns the array to write, or null when there is nothing to do, no `inherits_group`, no
 *   filament set to size it against, or it is already the right width. A project with FEWER
 *   entries than it needs is padded with empty strings, which the CLI reads as "this slot is a
 *   system preset", the same value BambuStudio itself writes for an uninherited slot, and the
 *   only honest one, since the real parent of a slot that was never recorded cannot be derived.
 */
export function repairInheritsGroup(record: Record<string, unknown>): string[] | null {
  if (!Array.isArray(record.inherits_group)) return null
  const filamentCount = filamentSlotCount(record)
  if (filamentCount === 0) return null

  const current = record.inherits_group.map((entry) => (typeof entry === 'string' ? entry : ''))
  const expected = filamentCount + 2
  if (current.length === expected) return null
  // Too short to tell the process entry from the machine entry: a 1-entry array could be either,
  // and guessing would move a preset name into the wrong role. Leave it and report.
  if (current.length < 2) return null

  const next = Array.from({ length: expected }, (_unused, index) => current[index] ?? '')
  next[0] = current[0] ?? ''
  // The machine lives at the END of both arrays, so it is carried across by position from the end,
  // never by index, that is precisely what a naive truncate gets wrong.
  //
  // This is the ONE place `length - 1` is right, and only because of what this function is. Every
  // reader and ordinary writer must locate the machine slot at `filament_count + 1`
  // (`machinePresetSlotIndexFor`), because that is where the engine reads it. Here the array is
  // known to be the WRONG width, so that index is meaningless by definition; the array's own end is
  // the only evidence left of where its author put the machine entry. Deliberate, and exempted by
  // name in `parallel-preset-record.guard.test.ts` rather than slipping past its scan.
  next[expected - 1] = current[current.length - 1] ?? ''
  // A slot beyond what the old array described has no recorded parent; empty is the honest value.
  for (let slot = 1; slot < expected - 1; slot++) {
    next[slot] = slot < current.length - 1 ? current[slot] ?? '' : ''
  }
  return next
}

/**
 * Inspect a raw `project_settings.config` JSON string for the width invariant.
 *
 * Returns null when the settings are absent/unparseable, when the project has no `inherits_group`,
 * or when it declares no filament set to size that array against, all genuinely unaffected rather
 * than "healthy by luck".
 */
export function inspectProjectInheritsGroup(
  projectSettingsJson: string | null | undefined
): InheritsGroupInspection | null {
  if (!projectSettingsJson) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(projectSettingsJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  if (!Array.isArray(record.inherits_group) || record.inherits_group.length === 0) return null

  const filamentCount = filamentSlotCount(record)
  if (filamentCount === 0) return null

  const actualLength = record.inherits_group.length
  const expectedLength = filamentCount + 2
  return {
    actualLength,
    expectedLength,
    filamentCount,
    inconsistent: actualLength !== expectedLength,
    // Asked of the repair itself, never re-derived here, one implementation decides both.
    repairable: repairInheritsGroup(record) !== null
  }
}
