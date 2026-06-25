/**
 * Owns the spool library's search / filter / sort / group / pagination concern,
 * mirroring the Library page's `useLibraryFilters`. Shared by the Filament tab
 * and the AMS-slot spool picker so both expose the same controls and derive the
 * visible/grouped/paged spools identically.
 */
import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { FilamentSpool } from '@printstream/shared'
import type { DirectorySortDirection, DirectoryViewMode } from '../../components/DirectoryControls'
import { useMobileViewport } from '../../components/useMobileViewport'
import { PAGE_SIZE_OPTIONS } from './constants'
import {
  EMPTY_FILTERS, applyFilters, countActiveFilters, deriveFacets, groupSpools, sortSpools,
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

export function useSpoolDirectory(spools: FilamentSpool[]): SpoolDirectory {
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [filters, setFilters] = useState<SpoolFilterState>(EMPTY_FILTERS)
  const [group, setGroup] = useState<SpoolGroupBy>('none')
  const [sort, setSort] = useState<SpoolSort>('used')
  const [direction, setDirection] = useState<DirectorySortDirection>('desc')
  const [viewMode, setViewMode] = useState<DirectoryViewMode>('list')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE_OPTIONS[0].value)
  const isMobile = useMobileViewport()
  const effectiveViewMode: DirectoryViewMode = isMobile ? 'icon' : viewMode

  const facets = useMemo(() => deriveFacets(spools), [spools])
  const visible = useMemo(
    () => sortSpools(applyFilters(spools, { ...filters, search: deferredSearch }), sort, direction),
    [spools, filters, deferredSearch, sort, direction]
  )

  // Reset to the first page whenever the result set changes shape.
  useEffect(() => {
    setPage(1)
  }, [deferredSearch, filters, sort, direction, pageSize, group])

  const activeFilterCount = countActiveFilters(filters)
  const grouped = group !== 'none'
  const total = visible.length
  const start = (page - 1) * pageSize
  const pageItems = grouped ? visible : visible.slice(start, start + pageSize)
  const groups = useMemo(() => groupSpools(pageItems, group), [pageItems, group])

  return {
    search, setSearch,
    filters, setFilters,
    clearFilters: () => setFilters(EMPTY_FILTERS),
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
