/**
 * The library's four metadata facet filters (file type, printer model, nozzle
 * size, plate type), rendered as the children of a `DirectoryFiltersMenu`.
 *
 * Each facet is **multi-select**: pick any number of values (OR within a facet,
 * AND across facets); an empty selection means "all". Shared by the Library page
 * and every library picker (print dialog, order picker, file picker) so the
 * filter set is identical everywhere — and so it is the single place to evolve.
 * Driven by the `useLibraryFilters` hook's state; each `Select` disables itself
 * when its facet has no values, uses `MultiSelectOption` (a leading check on the
 * selected values), and `disablePortal` so opening it does not dismiss the
 * surrounding filters panel.
 */
import { FormControl, FormLabel, Select } from '@mui/joy'
import { MultiSelectOption } from '../MultiSelectOption'
import type { LibraryFilters } from '../../hooks/useLibraryFilters'

type LibraryMetadataFilterFields = Pick<LibraryFilters,
  | 'fileTypeFilters' | 'setFileTypeFilters' | 'fileTypeOptions'
  | 'printerModelFilters' | 'setPrinterModelFilters' | 'printerModelOptions'
  | 'nozzleSizeFilters' | 'setNozzleSizeFilters' | 'nozzleSizeOptions'
  | 'plateTypeFilters' | 'setPlateTypeFilters' | 'plateTypeOptions'
>

export function LibraryMetadataFilters({ filters }: { filters: LibraryMetadataFilterFields }) {
  return (
    <>
      <FormControl>
        <FormLabel>File type</FormLabel>
        <Select
          multiple
          size="sm"
          value={filters.fileTypeFilters}
          onChange={(_event, value) => filters.setFileTypeFilters(value)}
          disabled={filters.fileTypeOptions.length === 0}
          placeholder="All file types"
          renderValue={() => filters.fileTypeFilters.length === 0 ? null : filters.fileTypeFilters.join(', ')}
          slotProps={{ listbox: { disablePortal: true } }}
        >
          {filters.fileTypeOptions.map((value) => (
            <MultiSelectOption key={value} value={value} selected={filters.fileTypeFilters.includes(value)}>{value}</MultiSelectOption>
          ))}
        </Select>
      </FormControl>
      <FormControl>
        <FormLabel>Printer model</FormLabel>
        <Select
          multiple
          size="sm"
          value={filters.printerModelFilters}
          onChange={(_event, value) => filters.setPrinterModelFilters(value)}
          disabled={filters.printerModelOptions.length === 0}
          placeholder="All printer models"
          renderValue={() => filters.printerModelFilters.length === 0 ? null : filters.printerModelFilters.join(', ')}
          slotProps={{ listbox: { disablePortal: true } }}
        >
          {filters.printerModelOptions.map((value) => (
            <MultiSelectOption key={value} value={value} selected={filters.printerModelFilters.includes(value)}>{value}</MultiSelectOption>
          ))}
        </Select>
      </FormControl>
      <FormControl>
        <FormLabel>Nozzle size</FormLabel>
        <Select
          multiple
          size="sm"
          value={filters.nozzleSizeFilters}
          onChange={(_event, value) => filters.setNozzleSizeFilters(value)}
          disabled={filters.nozzleSizeOptions.length === 0}
          placeholder="All nozzle sizes"
          renderValue={() => filters.nozzleSizeFilters.length === 0 ? null : filters.nozzleSizeFilters.join(', ')}
          slotProps={{ listbox: { disablePortal: true } }}
        >
          {filters.nozzleSizeOptions.map((value) => (
            <MultiSelectOption key={value} value={value} selected={filters.nozzleSizeFilters.includes(value)}>{value}</MultiSelectOption>
          ))}
        </Select>
      </FormControl>
      <FormControl>
        <FormLabel>Plate type</FormLabel>
        <Select
          multiple
          size="sm"
          value={filters.plateTypeFilters}
          onChange={(_event, value) => filters.setPlateTypeFilters(value)}
          disabled={filters.plateTypeOptions.length === 0}
          placeholder="All plate types"
          renderValue={() => filters.plateTypeFilters.length === 0 ? null : filters.plateTypeFilters.join(', ')}
          slotProps={{ listbox: { disablePortal: true } }}
        >
          {filters.plateTypeOptions.map((value) => (
            <MultiSelectOption key={value} value={value} selected={filters.plateTypeFilters.includes(value)}>{value}</MultiSelectOption>
          ))}
        </Select>
      </FormControl>
    </>
  )
}
