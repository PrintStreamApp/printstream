/**
 * The spool library's primary toolbar (search + sort + grouping + filters + page
 * size + view modes), wrapping the shared `DirectoryPrimaryToolbar`. Shared by
 * the Filament tab and the AMS-slot spool picker so both expose the same
 * controls. The three facet filters (material, brand, status) are multi-select.
 */
import { FormControl, FormLabel, Select } from '@mui/joy'
import type { FilamentSpoolStatus } from '@printstream/shared'
import { DirectoryPrimaryToolbar } from '../../components/DirectoryToolbar'
import { MultiSelectOption } from '../../components/MultiSelectOption'
import { PAGE_SIZE_OPTIONS } from './constants'
import { SPOOL_GROUP_OPTIONS, SPOOL_SORT_OPTIONS, STATUS_LABELS } from './filters'
import type { SpoolDirectory } from './useSpoolDirectory'

const ALL_STATUSES: FilamentSpoolStatus[] = ['available', 'loaded', 'low', 'empty', 'archived']

export function SpoolDirectoryToolbar({
  directory,
  searchPlaceholder = 'Search by brand, colour, material…',
  searchAriaLabel = 'Search spools',
  compactControls = false
}: {
  directory: SpoolDirectory
  searchPlaceholder?: string
  searchAriaLabel?: string
  compactControls?: boolean
}) {
  const { filters, setFilters, facets } = directory
  return (
    <DirectoryPrimaryToolbar
      searchValue={directory.search}
      onSearchChange={directory.setSearch}
      searchPlaceholder={searchPlaceholder}
      searchAriaLabel={searchAriaLabel}
      filters={{
        activeCount: directory.activeFilterCount,
        onClear: directory.clearFilters,
        clearDisabled: directory.activeFilterCount === 0,
        children: (
          <>
            <FormControl>
              <FormLabel>Material</FormLabel>
              <Select multiple value={filters.types} onChange={(_e, value) => setFilters((p) => ({ ...p, types: value }))} placeholder="All materials" renderValue={() => filters.types.length === 0 ? null : filters.types.join(', ')} slotProps={{ listbox: { disablePortal: true } }}>
                {facets.types.map((type) => <MultiSelectOption key={type} value={type} selected={filters.types.includes(type)}>{type}</MultiSelectOption>)}
              </Select>
            </FormControl>
            <FormControl>
              <FormLabel>Brand</FormLabel>
              <Select multiple value={filters.brands} onChange={(_e, value) => setFilters((p) => ({ ...p, brands: value }))} placeholder="All brands" renderValue={() => filters.brands.length === 0 ? null : filters.brands.join(', ')} slotProps={{ listbox: { disablePortal: true } }}>
                {facets.brands.map((brand) => <MultiSelectOption key={brand} value={brand} selected={filters.brands.includes(brand)}>{brand}</MultiSelectOption>)}
              </Select>
            </FormControl>
            <FormControl>
              <FormLabel>Status</FormLabel>
              <Select multiple value={filters.statuses} onChange={(_e, value) => setFilters((p) => ({ ...p, statuses: value }))} placeholder="All statuses" renderValue={() => filters.statuses.length === 0 ? null : filters.statuses.map((status) => STATUS_LABELS[status]).join(', ')} slotProps={{ listbox: { disablePortal: true } }}>
                {ALL_STATUSES.map((status) => <MultiSelectOption key={status} value={status} selected={filters.statuses.includes(status)}>{STATUS_LABELS[status]}</MultiSelectOption>)}
              </Select>
            </FormControl>
          </>
        )
      }}
      grouping={{ value: directory.group, options: SPOOL_GROUP_OPTIONS, onChange: directory.setGroup }}
      pageSizeValue={directory.pageSize}
      pageSizeOptions={PAGE_SIZE_OPTIONS}
      onPageSizeChange={directory.setPageSize}
      pageSizeAriaLabel="Spools per page"
      pageSizeRenderValue={(value) => `${value} per page`}
      sortValue={directory.sort}
      sortOptions={SPOOL_SORT_OPTIONS}
      onSortValueChange={directory.setSort}
      sortDirection={directory.direction}
      onSortDirectionChange={directory.setDirection}
      sortAriaLabel="Sort spools"
      {...(directory.isMobile
        // On phones the table is unusable, so spools are forced to icon view and
        // the view-mode toggle is hidden.
        ? {}
        : { viewMode: directory.viewMode, onViewModeChange: directory.setViewMode })}
      compactControls={compactControls}
    />
  )
}
