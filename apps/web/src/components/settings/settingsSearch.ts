/**
 * Finding a setting across ALL THREE catalogs at once, without knowing which one holds it.
 *
 * OWNS the cross-catalog index and its ranking. The per-dialog search (`catalogDialogFilter.ts`)
 * answers "does this key survive the filter" inside one already-open dialog; this answers "which
 * dialog is `sparse_infill_density` even in", which is the question a user actually has when the
 * setting they remember lives in a catalog they did not open.
 *
 * CONTRACT: a result names the catalog KIND and the key, and nothing else acts on it. The caller
 * opens that kind's dialog with the key as its search text, so the existing dialog does the
 * scrolling, grouping and editing. Deliberately NOT a fourth place that renders or writes a
 * setting: process overrides, filament variants and machine vectors each have their own write
 * rules, and a search result that edited in place would be a second implementation of all three.
 *
 * We beat BambuStudio's own searcher on purpose, and it is worth knowing where, because the gaps
 * are structural rather than accidental. Its index is populated as a SIDE EFFECT of building each
 * tab's widgets (`OptionsGroup::append_line`), so an option never rendered is unfindable; its
 * `opt_key` matching is commented out, so `sparse_infill_density` cannot be found by its own name;
 * and it gates on a hard `fuzzy_match > 90`. Our catalogs are generated data, so the whole set is
 * indexable up front, keys included, with no score floor to fall off.
 */
import {
  filamentSettingsCatalog,
  isProcessOptionVisibleInMode,
  machineSettingsCatalog,
  processSettingsCatalog,
  type ProcessSettingsCatalog
} from '@printstream/shared'

/** Which catalog a result lives in; also which dialog the caller opens for it. */
export type SettingsCatalogKind = 'process' | 'filament' | 'machine'

export interface SettingsSearchResult {
  kind: SettingsCatalogKind
  key: string
  label: string
  /** BambuStudio's description, shown as the result's secondary line. */
  tooltip: string
  /** Where it sits in its dialog: page title, then group title. */
  page: string
  group: string
}

const CATALOGS: ReadonlyArray<{ kind: SettingsCatalogKind; catalog: ProcessSettingsCatalog }> = [
  { kind: 'process', catalog: processSettingsCatalog },
  { kind: 'filament', catalog: filamentSettingsCatalog },
  { kind: 'machine', catalog: machineSettingsCatalog }
]

/** Human label for a kind, for the result group headings and the dialogs' titles. */
export const SETTINGS_CATALOG_KIND_LABELS: Record<SettingsCatalogKind, string> = {
  process: 'Process',
  filament: 'Filament',
  machine: 'Printer'
}

/**
 * Every option in every catalog, flattened with the breadcrumb it renders under.
 *
 * Walks pages -> groups -> lines rather than `catalog.options`, because only the page/group tree
 * says WHERE a key appears, and the breadcrumb is what makes a result actionable rather than a bare
 * name. A key the tree never mentions is therefore absent by construction, which is correct: the
 * dialog could not scroll to it either.
 *
 * Built once at module scope: the three catalogs are generated constants, so the index cannot go
 * stale, and rebuilding ~440 entries per keystroke is pure waste.
 */
interface IndexEntry {
  result: SettingsSearchResult
  /** Kept alongside so the develop-tier gate needs no per-keystroke catalog lookup. */
  option: ProcessSettingsCatalog['options'][string]
}

const INDEX: readonly IndexEntry[] = CATALOGS.flatMap(({ kind, catalog }) =>
  catalog.pages.flatMap((page) =>
    page.groups.flatMap((group) =>
      group.lines.flatMap((line) =>
        line.keys.flatMap((key) => {
          const option = catalog.options[key]
          if (!option) return []
          return [{
            option,
            result: {
              kind,
              key,
              label: option.label,
              tooltip: option.tooltip ?? '',
              page: page.title,
              group: group.title
            }
          }]
        })))))

/**
 * How well one entry matches, or null for no match at all.
 *
 * Higher is better. The tiers exist because substring matching alone buries the obvious answer:
 * typing "wall" against the process catalog matches a dozen tooltips mentioning walls before it
 * reaches the option actually CALLED "Wall loops". Ranking by WHERE the hit landed (key, then
 * label, then description) and how early it started puts the named thing first without needing a
 * fuzzy scorer or the score floor that makes BambuStudio's drop real answers.
 */
function scoreEntry(entry: SettingsSearchResult, query: string): number | null {
  const key = entry.key.toLowerCase()
  const label = entry.label.toLowerCase()
  if (key === query || label === query) return 1000
  if (key.startsWith(query)) return 900 - key.length
  if (label.startsWith(query)) return 800 - label.length
  if (key.includes(query)) return 700 - key.indexOf(query)
  if (label.includes(query)) return 600 - label.indexOf(query)
  if (entry.tooltip.toLowerCase().includes(query)) return 100
  return null
}

/**
 * Search every catalog. Returns at most `limit` results, best first.
 *
 * `showDeveloperOptions` mirrors the per-dialog gate: a develop-tier option the user cannot see in
 * its own dialog must not be findable here either, or the result opens a dialog that does not
 * contain it.
 *
 * A blank query returns nothing rather than everything: the whole index is ~440 rows, which is a
 * list to scroll rather than an answer.
 */
export function searchAllSettings(
  rawQuery: string,
  options: { showDeveloperOptions: boolean; limit?: number }
): SettingsSearchResult[] {
  const query = rawQuery.trim().toLowerCase()
  if (!query) return []
  const scored: Array<{ entry: SettingsSearchResult; score: number }> = []
  for (const { option, result } of INDEX) {
    if (!isProcessOptionVisibleInMode(option, options.showDeveloperOptions)) continue
    const score = scoreEntry(result, query)
    if (score != null) scored.push({ entry: result, score })
  }
  scored.sort((left, right) => right.score - left.score || left.entry.key.localeCompare(right.entry.key))
  return scored.slice(0, options.limit ?? 50).map((match) => match.entry)
}
