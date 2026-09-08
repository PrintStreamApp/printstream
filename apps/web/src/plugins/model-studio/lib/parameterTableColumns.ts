/**
 * Which settings the parameter table shows as columns, and how a chosen set is persisted.
 *
 * Owns three things and nothing else: the set a user MAY pick from, the set they get before they
 * pick, and the rule for reading a stored choice back. The table itself renders whatever this
 * hands it, so a column is added here rather than in the grid.
 *
 * The pickable set is `PER_OBJECT_PROCESS_KEYS` exactly. That is not a convenience, it is the
 * correctness boundary: a column is only meaningful if a row can carry its own value for that key,
 * and per-object overrides are restricted to those keys at every seam below this one (the settings
 * dialog's `allowedKeys`, `applyObjectProcessOverridesXml`'s allowlist, the bake). Offering a
 * column outside the set would show a value that is real but not per-object, so every row would
 * report the global figure and editing one would be impossible: a column that can only ever say the
 * same thing about every object is worse than no column, because it looks like agreement.
 *
 * Counterpart: `parameterTable.ts` builds the cells, `ParameterTableDialog.tsx` renders them.
 */
import { PER_OBJECT_PROCESS_KEYS, processSettingsCatalog } from '@printstream/shared'

/** Every setting a column may show. Ordered as the per-object catalog orders them. */
export const PARAMETER_TABLE_AVAILABLE_KEYS: readonly string[] = PER_OBJECT_PROCESS_KEYS

/**
 * The columns shown before the user picks any.
 *
 * Mirrors BambuStudio's own parameter-table columns, which is the set someone arriving from Studio
 * expects: layer height, wall loops, infill density, support, brim. Studio also carries an outer
 * wall speed column, deliberately absent here -- `outer_wall_speed` is not a per-object key for us,
 * so a column for it could only repeat the global value on every row (see the module header).
 *
 * Five is also about as wide as the grid can be before a laptop starts scrolling sideways; the
 * picker is how someone trades one of these for something they care about more.
 */
export const PARAMETER_TABLE_DEFAULT_KEYS: readonly string[] = [
  'layer_height',
  'wall_loops',
  'sparse_infill_density',
  'enable_support',
  'brim_type'
]

/** Per-device storage key for the chosen columns. Display preference, so it never leaves the browser. */
export const PARAMETER_TABLE_COLUMNS_STORAGE_KEY = 'printstream.editor.parameterTable.columns'

/**
 * A stored column choice, made safe to render.
 *
 * Drops anything not currently pickable and de-duplicates, because the stored value outlives the
 * code that wrote it: `PER_OBJECT_PROCESS_KEYS` can lose a key between releases, and a preference
 * naming a key the catalog no longer has would render a column with no label and no values in
 * every row.
 *
 * **An empty ARRAY is a choice; a non-array is corruption.** Only the second falls back to the
 * defaults. Clearing every setting column is a legitimate thing to want (the name and plate columns
 * still identify every object, and it is the narrowest the grid gets on a phone), and folding it
 * into the same branch as unreadable storage silently threw that preference away on the next open,
 * with nothing to show the user why. A stored value that survived the round trip is honoured;
 * anything that did not parse as a list has no preference in it to honour.
 *
 * Order is the USER'S, not the catalog's -- the picker lets columns be chosen in any order and the
 * table shows them in that order, so re-sorting here would silently undo a deliberate arrangement.
 */
export function sanitizeParameterTableColumns(stored: unknown): string[] {
  const allowed = new Set(PARAMETER_TABLE_AVAILABLE_KEYS)
  const keep = (entries: readonly unknown[]): string[] => {
    const seen = new Set<string>()
    const columns: string[] = []
    for (const entry of entries) {
      if (typeof entry !== 'string' || !allowed.has(entry) || seen.has(entry)) continue
      seen.add(entry)
      columns.push(entry)
    }
    return columns
  }
  // The DEFAULTS go through the same filter, not around it. They are drawn from the same catalog
  // and can lose a key exactly as a stored preference can, and the fallback is the worse case of
  // the two: the picker only lists `PARAMETER_TABLE_AVAILABLE_KEYS`, so a stale default renders a
  // column with no label and no values and offers no checkbox to untick it. That would have left
  // users with NO stored preference the only ones who could not fix it.
  if (!Array.isArray(stored)) return keep(PARAMETER_TABLE_DEFAULT_KEYS)
  return keep(stored)
}

/**
 * Column header text for a setting key.
 *
 * The catalog's label, which is the same string the settings dialog puts beside the control, so a
 * column and the dialog it opens cannot name one setting two ways. Falls back to the raw key, which
 * is terse but true; inventing a prettier label here is how the two surfaces would drift.
 */
export function parameterTableColumnLabel(key: string): string {
  return processSettingsCatalog.options[key]?.label ?? key
}
