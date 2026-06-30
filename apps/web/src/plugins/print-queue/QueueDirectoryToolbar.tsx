/**
 * The Queue view's primary toolbar (search + status filter + status grouping + page
 * size), wrapping the shared `DirectoryPrimaryToolbar` so it reads like every other
 * directory toolbar. Sort is locked to a single "Manual order" option because the
 * backlog is hand-ordered (drag / move up-down).
 */
import { FormControl, FormLabel, Select } from '@mui/joy'
import { DirectoryPrimaryToolbar } from '../../components/DirectoryToolbar'
import { MultiSelectOption } from '../../components/MultiSelectOption'
import {
  QUEUE_GROUP_OPTIONS,
  QUEUE_PAGE_SIZE_OPTIONS,
  QUEUE_SORT_OPTIONS,
  QUEUE_STATUS_LABELS,
  type QueueDirectory
} from './useQueueDirectory'

const PAGE_SIZE_OPTIONS = QUEUE_PAGE_SIZE_OPTIONS.map((value) => ({ value, label: `${value} per page` }))

export function QueueDirectoryToolbar({ directory }: { directory: QueueDirectory }) {
  return (
    <DirectoryPrimaryToolbar
      pinStorageKey="print-queue"
      searchValue={directory.search}
      onSearchChange={directory.setSearch}
      searchPlaceholder="Search queued files…"
      searchAriaLabel="Search the print queue"
      filters={directory.statusFacets.length > 0 ? {
        activeCount: directory.activeFilterCount,
        onClear: directory.clearFilters,
        clearDisabled: directory.activeFilterCount === 0,
        children: (
          <FormControl>
            <FormLabel>Status</FormLabel>
            <Select
              multiple
              value={directory.statuses}
              onChange={(_event, value) => directory.setStatuses(value)}
              placeholder="All statuses"
              renderValue={() => directory.statuses.length === 0 ? null : directory.statuses.map((status) => QUEUE_STATUS_LABELS[status]).join(', ')}
              slotProps={{ listbox: { disablePortal: true } }}
            >
              {directory.statusFacets.map((status) => (
                <MultiSelectOption key={status} value={status} selected={directory.statuses.includes(status)}>
                  {QUEUE_STATUS_LABELS[status]}
                </MultiSelectOption>
              ))}
            </Select>
          </FormControl>
        )
      } : undefined}
      grouping={{ value: directory.group, options: QUEUE_GROUP_OPTIONS, onChange: directory.setGroup }}
      pageSizeValue={directory.pageSize}
      pageSizeOptions={PAGE_SIZE_OPTIONS}
      onPageSizeChange={directory.setPageSize}
      pageSizeAriaLabel="Queued items per page"
      pageSizeRenderValue={(value) => `${value} per page`}
      sortValue="manual"
      sortOptions={QUEUE_SORT_OPTIONS}
      onSortValueChange={() => undefined}
      sortDirection="asc"
      onSortDirectionChange={() => undefined}
      sortAriaLabel="Sort order"
    />
  )
}
