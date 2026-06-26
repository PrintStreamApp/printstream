/**
 * Owns the spool library's search / filter / sort / group / pagination concern,
 * mirroring the Library page's `useLibraryFilters`. Shared by the Filament tab
 * and the AMS-slot spool picker so both expose the same controls and derive the
 * visible/grouped/paged spools identically.
 *
 * The display preferences — sort field + direction, grouping, filter facets,
 * page size, and view mode — persist to localStorage under `storageKey` so they
 * survive a reload; the search box and the current page index stay ephemeral.
 * Each caller passes its own key (see {@link SPOOL_DIRECTORY_PREFS_KEY} /
 * {@link SPOOL_PICKER_PREFS_KEY}) so the tab and the picker don't share state.
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { FilamentSpool, FilamentSpoolStatus } from '@printstream/shared'
import type { DirectorySortDirection, DirectoryViewMode } from '../../components/DirectoryControls'
import { useMobileViewport } from '../../components/useMobileViewport'
import { usePersistentState } from '../../hooks/usePersistentState'
import { PAGE_SIZE_OPTIONS, SPOOL_DIRECTORY_PREFS_KEY } from './constants'
import {
  applyFilters, countActiveFilters, deriveFacets, groupSpools, sortSpools,
  SPOOL_GROUP_OPTIONS, SPOOL_SORT_OPTIONS, STATUS_LABELS,
  type SpoolFilterState, type SpoolGroup, type SpoolGroupBy, type SpoolSort
} from './filters'

export interface SpoolDirectory {
  search: string
  setSearch: (value: string) => void
  filters: SpoolFilterState
  setFilters: React.Dispatch<React.SetStateAction<SpoolFilterState>>
  clearFilters: () => void
  group: SpoolGroupBy
  setGroup: (value: SpoolGroupBy) => void
  sort: SpoolSort
  setSort: (value: SpoolSort) => void
  direction: DirectorySortDirection
  setDirection: (value: DirectorySortDirection) => void
  viewMode: DirectoryViewMode
  setViewMode: (value: DirectoryViewMode) => void
  /** True when the viewport is phone-sized. */
  isMobile: boolean
  /** View mode to actually render with: forced to `icon` on mobile (the table is unusable there). */
  effectiveViewMode: DirectoryViewMode
  page: number
  setPage: React.Dispatch<React.SetStateAction<number>>
  pageSize: number
  setPageSize: (value: number) => void
  facets: { types: string[]; brands: string[] }
  activeFilterCount: number
  /** All spools matching search + filters, sorted (before paging). */
  visible: FilamentSpool[]
  total: number
  grouped: boolean
  start: number
  /** The spools to render: the current page when ungrouped, all matches when grouped. */
  pageItems: FilamentSpool[]
  groups: SpoolGroup[]
}

/** The persisted subset of a spool directory's state (everything but search + page index). */
interface SpoolDirectoryPrefs {
  sort: SpoolSort
  direction: DirectorySortDirection
  group: SpoolGroupBy
  viewMode: DirectoryViewMode
  pageSize: number
  filters: { types: string[]; brands: string[]; statuses: FilamentSpoolStatus[] }
}

const VALID_SORTS = new Set<string>(SPOOL_SORT_OPTIONS.map((option) => option.value))
const VALID_GROUPS = new Set<string>(SPOOL_GROUP_OPTIONS.map((option) => option.value))
const VALID_STATUSES = new Set<string>(Object.keys(STATUS_LABELS))
const VALID_PAGE_SIZES = new Set<number>(PAGE_SIZE_OPTIONS.map((option) => option.value))

const DEFAULT_PREFS: SpoolDirectoryPrefs = {
  sort: 'used',
  direction: 'desc',
  group: 'none',
  viewMode: 'list',
  pageSize: PAGE_SIZE_OPTIONS[0].value,
  filters: { types: [], brands: [], statuses: [] }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/** Coerce a stored (or corrupt) blob into a complete, valid prefs object, field by field. */
function sanitizeSpoolDirectoryPrefs(value: unknown): SpoolDirectoryPrefs {
  const raw = (value ?? {}) as Record<string, unknown>
  const rawFilters = (raw.filters ?? {}) as Record<string, unknown>
  return {
    sort: VALID_SORTS.has(raw.sort as string) ? (raw.sort as SpoolSort) : DEFAULT_PREFS.sort,
    direction: raw.direction === 'asc' ? 'asc' : 'desc',
    group: VALID_GROUPS.has(raw.group as string) ? (raw.group as SpoolGroupBy) : DEFAULT_PREFS.group,
    viewMode: raw.viewMode === 'icon' ? 'icon' : 'list',
    pageSize: VALID_PAGE_SIZES.has(raw.pageSize as number) ? (raw.pageSize as number) : DEFAULT_PREFS.pageSize,
    filters: {
      types: asStringArray(rawFilters.types),
      brands: asStringArray(rawFilters.brands),
      statuses: asStringArray(rawFilters.statuses).filter((status): status is FilamentSpoolStatus => VALID_STATUSES.has(status))
    }
  }
}

export function useSpoolDirectory(
  spools: FilamentSpool[],
  options?: { storageKey?: string }
): SpoolDirectory {
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [prefs, setPrefs] = usePersistentState<SpoolDirectoryPrefs>(
    options?.storageKey ?? SPOOL_DIRECTORY_PREFS_KEY,
    DEFAULT_PREFS,
    sanitizeSpoolDirectoryPrefs
  )
  const [page, setPage] = useState(1)
  const isMobile = useMobileViewport()

  const { sort, direction, group, viewMode, pageSize } = prefs
  const effectiveViewMode: DirectoryViewMode = isMobile ? 'icon' : viewMode

  const setSort = useCallback((value: SpoolSort) => setPrefs((p) => ({ ...p, sort: value })), [setPrefs])
  const setDirection = useCallback((value: DirectorySortDirection) => setPrefs((p) => ({ ...p, direction: value })), [setPrefs])
  const setGroup = useCallback((value: SpoolGroupBy) => setPrefs((p) => ({ ...p, group: value })), [setPrefs])
  const setViewMode = useCallback((value: DirectoryViewMode) => setPrefs((p) => ({ ...p, viewMode: value })), [setPrefs])
  const setPageSize = useCallback((value: number) => setPrefs((p) => ({ ...p, pageSize: value })), [setPrefs])
  const clearFilters = useCallback(() => setPrefs((p) => ({ ...p, filters: { types: [], brands: [], statuses: [] } })), [setPrefs])

  // `filters` keeps the legacy SpoolFilterState shape (with a `search` field the
  // toolbar never writes) so callers stay untouched; the persisted prefs hold
  // only the facet arrays. setFilters maps either form back onto the facets.
  const filters = useMemo<SpoolFilterState>(() => ({ search: '', ...prefs.filters }), [prefs.filters])
  const setFilters = useCallback<React.Dispatch<React.SetStateAction<SpoolFilterState>>>((update) => {
    setPrefs((prev) => {
      const current: SpoolFilterState = { search: '', ...prev.filters }
      const next = typeof update === 'function' ? (update as (value: SpoolFilterState) => SpoolFilterState)(current) : update
      return { ...prev, filters: { types: next.types, brands: next.brands, statuses: next.statuses } }
    })
  }, [setPrefs])

  const facets = useMemo(() => deriveFacets(spools), [spools])
  const visible = useMemo(
    () => sortSpools(applyFilters(spools, { ...filters, search: deferredSearch }), sort, direction),
    [spools, filters, deferredSearch, sort, direction]
  )

  // Reset to the first page whenever the result set changes shape.
  useEffect(() => {
    setPage(1)
  }, [deferredSearch, filters, sort, direction, pageSize, group])

  // Drop persisted facet selections that no longer exist once real spools load.
  // Guarded on a non-empty list so the initial (still-loading) empty facet set
  // can't silently wipe the user's saved filters.
  useEffect(() => {
    if (spools.length === 0) return
    setPrefs((prev) => {
      const types = prev.filters.types.filter((type) => facets.types.includes(type))
      const brands = prev.filters.brands.filter((brand) => facets.brands.includes(brand))
      if (types.length === prev.filters.types.length && brands.length === prev.filters.brands.length) return prev
      return { ...prev, filters: { ...prev.filters, types, brands } }
    })
  }, [spools.length, facets, setPrefs])

  const activeFilterCount = countActiveFilters(filters)
  const grouped = group !== 'none'
  const total = visible.length
  const start = (page - 1) * pageSize
  const pageItems = grouped ? visible : visible.slice(start, start + pageSize)
  const groups = useMemo(() => groupSpools(pageItems, group), [pageItems, group])

  return {
    search, setSearch,
    filters, setFilters,
    clearFilters,
    group, setGroup,
    sort, setSort,
    direction, setDirection,
    viewMode, setViewMode,
    isMobile, effectiveViewMode,
    page, setPage,
    pageSize, setPageSize,
    facets, activeFilterCount,
    visible, total, grouped, start, pageItems, groups
  }
}
