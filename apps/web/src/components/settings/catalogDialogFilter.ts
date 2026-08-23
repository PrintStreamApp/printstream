/**
 * Which settings a catalog dialog SHOWS, and the counts its tabs display.
 *
 * Pure and catalog-agnostic on purpose: the process, filament and machine dialogs all answer the
 * same three questions (does this key render at all, does this page still have content, how many
 * settings does the current filter leave on it) and used to answer them with three hand-copied
 * loops that had already drifted: the process dialog counted matches under both the search box and
 * "Changed only", the filament dialog counted only the search. Extracting them means a page's tab
 * count and its visibility can never disagree, because both walk this one predicate.
 *
 * Counterpart: `SettingsCatalogDialog.tsx`, which renders exactly the keys `isKeyShown` accepts.
 */
import { isProcessOptionVisibleInMode, type ProcessSettingsCatalog } from '@printstream/shared'

/** What the dialog needs to know about one key to decide whether it is on screen. */
export interface CatalogFilterContext {
  catalog: ProcessSettingsCatalog
  /** Whether BambuStudio's develop-tier options are revealed (developer-mode preference). */
  showDeveloperOptions: boolean
  /** Lower-cased search text; empty when the box is clear. */
  normalizedQuery: string
  /** Whether the "Changed only" filter is on. */
  showChangedOnly: boolean
  /** Conditional visibility: the process dialog's field-state engine. Defaults to always visible. */
  isKeyVisible?: (key: string) => boolean
  /** Counts toward "Changed only" and the tab emphasis. */
  isModified: (key: string) => boolean
}

/** Case-insensitive match of a setting against the search query (label, key, or tooltip). */
export function catalogKeyMatchesQuery(
  catalog: ProcessSettingsCatalog,
  key: string,
  normalizedQuery: string
): boolean {
  const option = catalog.options[key]
  if (!option) return false
  return option.label.toLowerCase().includes(normalizedQuery)
    || key.toLowerCase().includes(normalizedQuery)
    || (option.tooltip?.toLowerCase().includes(normalizedQuery) ?? false)
}

/**
 * Whether a key renders under the current filters.
 *
 * Order matters for the "Changed only" case: a key hidden by its controlling toggle must not count
 * as changed, or its tab lights up with no changed row to show for it.
 */
export function isKeyShown(key: string, context: CatalogFilterContext): boolean {
  const option = context.catalog.options[key]
  if (!option || !isProcessOptionVisibleInMode(option, context.showDeveloperOptions)) return false
  if (context.isKeyVisible && !context.isKeyVisible(key)) return false
  if (context.normalizedQuery && !catalogKeyMatchesQuery(context.catalog, key, context.normalizedQuery)) return false
  if (context.showChangedOnly && !context.isModified(key)) return false
  return true
}

/** Whether either filter is engaged: the tabs show per-page counts only then. */
export function catalogFiltersActive(context: Pick<CatalogFilterContext, 'normalizedQuery' | 'showChangedOnly'>): boolean {
  return Boolean(context.normalizedQuery) || context.showChangedOnly
}

/** Every key on a page, in catalog order. */
function pageKeys(catalog: ProcessSettingsCatalog, pageIndex: number): string[] {
  const page = catalog.pages[pageIndex]
  if (!page) return []
  return page.groups.flatMap((group) => group.lines.flatMap((line) => line.keys))
}

/** Per-page count of the settings the current filters leave visible (the number in the tab label). */
export function countShownPerPage(context: CatalogFilterContext): number[] {
  if (!catalogFiltersActive(context)) return context.catalog.pages.map(() => 0)
  return context.catalog.pages.map((_page, index) =>
    pageKeys(context.catalog, index).filter((key) => isKeyShown(key, context)).length)
}

/** Whether each page has anything to show: pages with none are hidden entirely. */
export function pagesWithContent(context: CatalogFilterContext): boolean[] {
  return context.catalog.pages.map((_page, index) =>
    pageKeys(context.catalog, index).some((key) => isKeyShown(key, context)))
}

/**
 * Pages carrying a modified setting, for the tab emphasis.
 *
 * Deliberately ignores the search box and "Changed only": the emphasis says where a user's changes
 * ARE, which must not move as they type. It does honour visibility, so a change on a hidden line
 * never marks a tab the user cannot open.
 */
export function pagesWithModified(context: CatalogFilterContext): Set<number> {
  const unfiltered: CatalogFilterContext = { ...context, normalizedQuery: '', showChangedOnly: false }
  const result = new Set<number>()
  context.catalog.pages.forEach((_page, index) => {
    const modified = pageKeys(context.catalog, index)
      .some((key) => isKeyShown(key, unfiltered) && context.isModified(key))
    if (modified) result.add(index)
  })
  return result
}

/** How many settings count as modified across the whole catalog: the title's "*" and the badge. */
export function countModified(context: CatalogFilterContext): number {
  const unfiltered: CatalogFilterContext = { ...context, normalizedQuery: '', showChangedOnly: false }
  return Object.keys(context.catalog.options)
    .filter((key) => isKeyShown(key, unfiltered) && context.isModified(key))
    .length
}
