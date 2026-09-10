/**
 * Which settings differ between two presets of the same kind (BambuStudio's `DiffPresetDialog`).
 *
 * OWNS the comparison and its ordering; the dialog only renders what this returns.
 *
 * THE ONE RULE THAT MATTERS: values are compared with `processConfigValuesEqual` AND THE CATALOG
 * OPTION, never with `===` on the serialized strings. BambuStudio writes one value several ways
 * depending on where it landed: a preset JSON holds `"45.0"` where a project config holds `"45%"`,
 * and a preset that never mentions `post_process` means the same as an explicit `[]`. So string
 * equality reports differences that are not differences. That is worse in a diff than anywhere
 * else: the whole point of the surface is that its rows are real.
 *
 * Rows are restricted to keys the CATALOG knows, which is deliberate and worth stating because
 * BambuStudio does the opposite and it is a known bug there: keys its searcher does not know
 * (`default_print_profile`, `printer_model`, `printer_settings_id`) are silently dropped from ITS
 * diff, whereas here a non-catalog key has no label, no group and no formatter, so a row for it
 * would read as `printer_variant: 0.4 vs 0.4` with nothing to explain it. The count of skipped keys
 * is reported instead, so the omission is visible rather than silent.
 */
import {
  isProcessOptionVisibleInMode,
  processConfigValuesEqual,
  type ProcessSettingsCatalog
} from '@printstream/shared'
import { formatSettingValueForDisplay } from './settingValueDisplay'

export interface PresetDiffRow {
  key: string
  label: string
  /** Page and group titles, so a row can be placed without opening the dialog it lives in. */
  page: string
  group: string
  /**
   * Formatted for display (enum codes resolved, booleans as on/off, unit appended). A side that
   * does not set the key at all reads as {@link PRESET_DIFF_UNSET_LABEL}, which is why there is no
   * separate "only one side" flag: the cell already says it, and after the caller's defaults pass
   * the case is rare enough that a second signal was carrying nothing.
   */
  left: string
  right: string
}

export interface PresetDiff {
  rows: PresetDiffRow[]
  /** Keys that differ but are not in the catalog, so they have no row. Reported, never hidden. */
  skippedKeyCount: number
}

/** What an absent value is called in a row, rather than rendering an empty cell. */
export const PRESET_DIFF_UNSET_LABEL = 'Not set'

function displayValue(
  catalog: ProcessSettingsCatalog,
  key: string,
  value: string | string[] | undefined
): string {
  if (value === undefined) return PRESET_DIFF_UNSET_LABEL
  const option = catalog.options[key]
  // A vector is formatted PER ELEMENT, not joined and formatted once: over half the machine catalog
  // is vectors, and their elements are enum codes and booleans that the raw join would show as `2`
  // and `1` rather than as the names the dialogs use.
  const formatted = Array.isArray(value)
    ? value.map((element) => formatSettingValueForDisplay(option, element)).join(', ')
    : formatSettingValueForDisplay(option, value)
  return formatted.trim() === '' ? PRESET_DIFF_UNSET_LABEL : formatted
}

/**
 * Compare two resolved preset configs.
 *
 * Walks the CATALOG's page/group tree rather than the configs' own keys, so rows come out in the
 * order the settings dialogs show them (a diff sorted by key name scatters related settings) and
 * every row has a breadcrumb by construction. The configs are then swept for differing keys the
 * tree does not mention, which are counted rather than listed.
 */
export function buildPresetDiff(
  catalog: ProcessSettingsCatalog,
  left: Record<string, string | string[]>,
  right: Record<string, string | string[]>,
  options: { showDeveloperOptions: boolean }
): PresetDiff {
  const rows: PresetDiffRow[] = []
  // Two sets, not one, and the difference is the whole correctness of `skippedKeyCount`. `visited`
  // dedupes the tree walk (a key may appear on more than one line); `accounted` is only the keys
  // this surface has actually SPOKEN FOR, either by rendering a row or by finding them equal. A key
  // the tree names but hides (develop-tier, with developer mode off) is visited and NOT accounted,
  // so the sweep below still counts it. Marking it accounted is what let a develop-tier difference
  // vanish from both the rows and the count, leaving the dialog saying "These presets match".
  const visited = new Set<string>()
  const accounted = new Set<string>()

  for (const page of catalog.pages) {
    for (const group of page.groups) {
      for (const line of group.lines) {
        for (const key of line.keys) {
          if (visited.has(key)) continue
          visited.add(key)
          const option = catalog.options[key]
          if (!option || !isProcessOptionVisibleInMode(option, options.showDeveloperOptions)) continue
          accounted.add(key)
          if (processConfigValuesEqual(left[key], right[key], option)) continue
          rows.push({
            key,
            label: option.label,
            page: page.title,
            group: group.title,
            left: displayValue(catalog, key, left[key]),
            right: displayValue(catalog, key, right[key])
          })
        }
      }
    }
  }

  let skippedKeyCount = 0
  for (const key of new Set([...Object.keys(left), ...Object.keys(right), ...visited])) {
    if (accounted.has(key)) continue
    const option = catalog.options[key]
    // A key the catalog has an option for but no page renders (or that the current tier hides) is
    // still unshowable here, so it counts as skipped exactly like one the catalog never heard of.
    if (!processConfigValuesEqual(left[key], right[key], option)) skippedKeyCount += 1
  }

  return { rows, skippedKeyCount }
}
