/**
 * The printers-overview directory toolbar: search, sort, grouping, attribute
 * filters, and page size. Deliberately omits the list/icon view-mode toggle —
 * on this page the saved-views selector + "Edit view" button in the page header
 * are the "view" mechanism instead (see PrintersView).
 *
 * Sort and the four filters are the same controls the Edit-view dialog used to
 * own; here they drive the active saved view (or the Overview defaults) live.
 */
import { FormControl, FormLabel, Option, Select } from '@mui/joy'
import type { PrinterModel, Printer } from '@printstream/shared'
import { DirectoryPrimaryToolbar } from '../DirectoryToolbar'
import type { DirectorySortDirection } from '../DirectoryControls'
import { MultiSelectOption } from '../MultiSelectOption'
import {
  PRINTER_GROUP_OPTIONS,
  PRINTER_OVERVIEW_PAGE_SIZE_OPTIONS,
  PRINTER_OVERVIEW_SORT_FIELD_OPTIONS,
  PRINTER_STATE_FILTER_OPTIONS,
  buildNozzleDiameterFilterOptions,
  buildPlateTypeFilterOptions,
  buildPrinterModelFilterOptions,
  printerStateFilterLabel,
  type PrinterGroupBy,
  type PrinterStateFilter
} from '../../lib/printersViewHelpers'
import type { PrinterViewSort } from '@printstream/shared'

export function PrinterOverviewToolbar({
  printers,
  search,
  onSearchChange,
  group,
  onGroupChange,
  pageSize,
  onPageSizeChange,
  sort,
  onSortFieldChange,
  onSortDirectionChange,
  stateFilter,
  onStateFilterChange,
  modelFilter,
  onModelFilterChange,
  nozzleDiameterFilter,
  onNozzleDiameterFilterChange,
  plateTypeFilter,
  onPlateTypeFilterChange,
  printerIds,
  onPrinterIdsChange,
  onClearFilters
}: {
  printers: Printer[]
  search: string
  onSearchChange: (value: string) => void
  group: PrinterGroupBy
  onGroupChange: (value: PrinterGroupBy) => void
  pageSize: number
  onPageSizeChange: (value: number) => void
  sort: PrinterViewSort
  onSortFieldChange: (key: PrinterViewSort['key']) => void
  onSortDirectionChange: (direction: DirectorySortDirection) => void
  stateFilter: PrinterStateFilter
  onStateFilterChange: (value: PrinterStateFilter) => void
  modelFilter: PrinterModel[]
  onModelFilterChange: (value: PrinterModel[]) => void
  nozzleDiameterFilter: string[]
  onNozzleDiameterFilterChange: (value: string[]) => void
  plateTypeFilter: string[]
  onPlateTypeFilterChange: (value: string[]) => void
  /** Which printers the view includes (empty = all). Lives here, not in the View settings dialog. */
  printerIds: string[]
  onPrinterIdsChange: (value: string[]) => void
  onClearFilters: () => void
}) {
  const modelOptions = buildPrinterModelFilterOptions(printers, modelFilter)
  const nozzleOptions = buildNozzleDiameterFilterOptions(nozzleDiameterFilter)
  const plateOptions = buildPlateTypeFilterOptions(printers, plateTypeFilter)
  const activeFilterCount = (stateFilter !== 'all' ? 1 : 0)
    + (modelFilter.length > 0 ? 1 : 0)
    + (nozzleDiameterFilter.length > 0 ? 1 : 0)
    + (plateTypeFilter.length > 0 ? 1 : 0)
    + (printerIds.length > 0 ? 1 : 0)

  return (
    <DirectoryPrimaryToolbar
      pinStorageKey="printers.overview"
      searchValue={search}
      onSearchChange={onSearchChange}
      searchPlaceholder="Search printers by name, model, or host"
      searchAriaLabel="Search printers"
      grouping={{ value: group, options: PRINTER_GROUP_OPTIONS, onChange: onGroupChange }}
      pageSizeValue={pageSize}
      pageSizeOptions={PRINTER_OVERVIEW_PAGE_SIZE_OPTIONS.map((value) => ({ value, label: `${value} per page` }))}
      onPageSizeChange={onPageSizeChange}
      pageSizeAriaLabel="Printers per page"
      pageSizeRenderValue={(value) => `${value} per page`}
      sortValue={sort.key}
      sortOptions={PRINTER_OVERVIEW_SORT_FIELD_OPTIONS}
      onSortValueChange={onSortFieldChange}
      sortDirection={sort.direction}
      onSortDirectionChange={onSortDirectionChange}
      sortAriaLabel="Sort printers by"
      filters={{
        activeCount: activeFilterCount,
        onClear: onClearFilters,
        clearDisabled: activeFilterCount === 0,
        children: (
          <>
            <FormControl>
              <FormLabel>State</FormLabel>
              <Select
                size="sm"
                value={stateFilter}
                onChange={(_event, value) => value && onStateFilterChange(value)}
                slotProps={{ listbox: { disablePortal: true } }}
              >
                {PRINTER_STATE_FILTER_OPTIONS.map((value) => (
                  <Option key={`overview-state-${value}`} value={value}>{printerStateFilterLabel(value)}</Option>
                ))}
              </Select>
            </FormControl>
            <FormControl>
              <FormLabel>Model</FormLabel>
              <Select
                size="sm"
                multiple
                placeholder="All models"
                value={modelFilter}
                onChange={(_event, value) => onModelFilterChange(value)}
                renderValue={(selected) => (selected.length === 0 ? 'All models' : selected.map((option) => option.label).join(', '))}
                slotProps={{ listbox: { disablePortal: true, sx: { maxHeight: 280, overflow: 'auto' } } }}
              >
                {modelOptions.map((model) => (
                  <MultiSelectOption key={`overview-model-${model}`} value={model} selected={modelFilter.includes(model)}>{model}</MultiSelectOption>
                ))}
              </Select>
            </FormControl>
            <FormControl>
              <FormLabel>Nozzle diameter</FormLabel>
              <Select
                size="sm"
                multiple
                placeholder="All sizes"
                value={nozzleDiameterFilter}
                onChange={(_event, value) => onNozzleDiameterFilterChange(value)}
                renderValue={(selected) => (selected.length === 0 ? 'All sizes' : selected.map((option) => `${option.value} mm`).join(', '))}
                slotProps={{ listbox: { disablePortal: true, sx: { maxHeight: 280, overflow: 'auto' } } }}
              >
                {nozzleOptions.map((diameter) => (
                  <MultiSelectOption key={`overview-nozzle-${diameter}`} value={diameter} selected={nozzleDiameterFilter.includes(diameter)}>{diameter} mm</MultiSelectOption>
                ))}
              </Select>
            </FormControl>
            <FormControl>
              <FormLabel>Plate type</FormLabel>
              <Select
                size="sm"
                multiple
                placeholder="All plate types"
                value={plateTypeFilter}
                onChange={(_event, value) => onPlateTypeFilterChange(value)}
                renderValue={(selected) => (selected.length === 0 ? 'All plate types' : selected.map((option) => option.label).join(', '))}
                slotProps={{ listbox: { disablePortal: true, sx: { maxHeight: 280, overflow: 'auto' } } }}
              >
                {plateOptions.map((plateType) => (
                  <MultiSelectOption key={`overview-plate-${plateType}`} value={plateType} selected={plateTypeFilter.includes(plateType)}>{plateType}</MultiSelectOption>
                ))}
              </Select>
            </FormControl>
            <FormControl>
              <FormLabel>Printers</FormLabel>
              <Select
                size="sm"
                multiple
                placeholder="All printers"
                value={printerIds}
                onChange={(_event, value) => onPrinterIdsChange(value)}
                renderValue={(selected) => (selected.length === 0
                  ? 'All printers'
                  : selected.map((option) => printers.find((printer) => printer.id === option.value)?.name ?? option.value).join(', '))}
                slotProps={{ listbox: { disablePortal: true, sx: { maxHeight: 280, overflow: 'auto' } } }}
              >
                {printers.map((printer) => (
                  <MultiSelectOption key={`overview-printer-${printer.id}`} value={printer.id} selected={printerIds.includes(printer.id)}>{printer.name}</MultiSelectOption>
                ))}
              </Select>
            </FormControl>
          </>
        )
      }}
    />
  )
}
