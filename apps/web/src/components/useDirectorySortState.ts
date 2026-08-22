/**
 * A directory view's persisted sort: which field, which direction, and the props
 * that drive `DirectoryPrimaryToolbar`.
 *
 * Owns the three rules a hand-rolled sort keeps missing, so a view cannot get
 * one of them and not the others:
 *
 * 1. **It persists.** Sort field and direction are display PREFERENCES, and a
 *    directory that forgets them makes an operator re-pick the same order every
 *    visit. Two of the three call sites shipped with plain `useState`.
 * 2. **It is validated on read.** A stored value is untrusted input: it was
 *    written by an older build, another tab, or by hand. An unrecognized field
 *    reaching a server that no longer accepts it 400s every page load, with no
 *    way back except clearing site data.
 * 3. **Changing it resets the page** (via `onChange`). The page number indexes
 *    the ORDER, so keeping it shows page 3 of a list the reader has never seen
 *    the top of. Both views that reset on the FIELD had forgotten the DIRECTION.
 *
 * Lives beside the toolbar rather than in `hooks/` because it exists to feed one
 * component's props, like `useMobileViewport`.
 */
import { useCallback, useMemo } from 'react'
import type { DirectorySortDirection, DirectorySortOption } from './DirectoryControls'
import { useLocalStorageState } from '../hooks/useLocalStorageState'

/**
 * Reads a scalar preference that may be stored in either of two formats.
 *
 * `usePersistentState` JSON-serializes, so the workspace directory's saved sort
 * is `"name"` — with the quotes — while this hook writes the bare `name`. Both
 * are accepted, so moving a view onto this hook does not silently reset the
 * sort every operator already had; the next write lands in the bare form and the
 * quoted one is simply left behind.
 *
 * An unrecognized value falls back rather than throwing: see rule 2 above.
 */
function parseStoredChoice<T extends string>(
  raw: string,
  isAllowed: (value: string) => boolean,
  fallback: T
): T {
  const unquoted = raw.length > 1 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
  return isAllowed(unquoted) ? unquoted as T : fallback
}

export function useDirectorySortState<T extends string>({
  sortByKey,
  sortDirectionKey,
  options,
  defaultSortBy,
  defaultDirection = 'desc',
  ariaLabel,
  legacySortByKeys = [],
  legacySortDirectionKeys = [],
  onChange
}: {
  /** Storage key for the field. A persisted identifier — renaming one needs `legacySortByKeys`. */
  sortByKey: string
  sortDirectionKey: string
  /** The menu's options, and the set a stored field is validated against. */
  options: ReadonlyArray<DirectorySortOption<T>>
  defaultSortBy: T
  defaultDirection?: DirectorySortDirection
  /** Per-view copy, e.g. "Sort customers". */
  ariaLabel: string
  legacySortByKeys?: ReadonlyArray<string>
  legacySortDirectionKeys?: ReadonlyArray<string>
  /**
   * Run after either half changes — pass `() => setPage(1)`. Optional only
   * because a caller may already reset the page by another route (the workspace
   * directory resets on its filters too, in one effect); every other caller
   * should pass it.
   */
  onChange?: () => void
}): {
  sortBy: T
  sortDirection: DirectorySortDirection
  /** Spread onto `DirectoryPrimaryToolbar`. */
  sortProps: {
    sortValue: T
    sortOptions: ReadonlyArray<DirectorySortOption<T>>
    onSortValueChange: (value: T) => void
    sortDirection: DirectorySortDirection
    onSortDirectionChange: (direction: DirectorySortDirection) => void
    sortAriaLabel: string
  }
} {
  // Keyed on the option VALUES, not the array identity: callers routinely pass
  // an inline literal, whose new identity each render would otherwise re-run the
  // storage read (see the unstable-dependency rule in apps/web/the development notes).
  const allowedValues = options.map((option) => option.value).join('\n')
  const isAllowedSortBy = useCallback(
    (value: string) => allowedValues.split('\n').includes(value),
    [allowedValues]
  )
  const parseSortBy = useCallback(
    (raw: string) => parseStoredChoice<T>(raw, isAllowedSortBy, defaultSortBy),
    [defaultSortBy, isAllowedSortBy]
  )
  const parseDirection = useCallback(
    (raw: string) => parseStoredChoice<DirectorySortDirection>(
      raw,
      (value) => value === 'asc' || value === 'desc',
      defaultDirection
    ),
    [defaultDirection]
  )

  const [sortBy, setSortBy] = useLocalStorageState<T>(
    sortByKey,
    defaultSortBy,
    parseSortBy,
    String,
    legacySortByKeys
  )
  const [sortDirection, setSortDirection] = useLocalStorageState<DirectorySortDirection>(
    sortDirectionKey,
    defaultDirection,
    parseDirection,
    String,
    legacySortDirectionKeys
  )

  const sortProps = useMemo(() => ({
    sortValue: sortBy,
    sortOptions: options,
    onSortValueChange: (value: T) => { setSortBy(value); onChange?.() },
    sortDirection,
    onSortDirectionChange: (direction: DirectorySortDirection) => { setSortDirection(direction); onChange?.() },
    sortAriaLabel: ariaLabel
  }), [ariaLabel, onChange, options, setSortBy, setSortDirection, sortBy, sortDirection])

  return { sortBy, sortDirection, sortProps }
}
