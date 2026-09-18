/**
 * Directory controls for saved calibrations. Keeps display preferences across
 * visits; search and page remain local. The caller owns row rendering/actions.
 */
import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react'
import { FormControl, FormLabel, Select, Stack } from '@mui/joy'
import ScienceRoundedIcon from '@mui/icons-material/ScienceRounded'
import type { CalibrationResult, CalibrationRun, Printer } from '@printstream/shared'
import { DirectoryPrimaryToolbar } from '../../components/DirectoryToolbar'
import { useDirectorySortState } from '../../components/useDirectorySortState'
import { MultiSelectOption } from '../../components/MultiSelectOption'
import { PaginatedSection } from '../../components/PaginationFooter'
import { EmptyState } from '../../components/EmptyState'
import { usePersistentState } from '../../hooks/usePersistentState'
import { calibrationKindLabel, calibrationValueLabel, calibrationPrinterTargetLabel } from './runPresentation'

const SORT_OPTIONS = [
  { value: 'updatedAt', label: 'Last updated' },
  { value: 'kind', label: 'Test' },
  { value: 'printerModel', label: 'Printer model' },
  { value: 'scope', label: 'Save scope' }
] as const
const PAGE_SIZES = [12, 24, 48].map((value) => ({ value, label: `${value} per page` }))
const FILTER_FIELDS = [
  ['kind', 'Test'], ['printerModel', 'Printer model'], ['nozzleDiameter', 'Nozzle size'], ['scope', 'Save scope']
] as const
type FilterField = typeof FILTER_FIELDS[number][0]
type Prefs = { pageSize: number; filters: Record<FilterField, string[]> }
const DEFAULT_PREFS: Prefs = { pageSize: 12, filters: { kind: [], printerModel: [], nozzleDiameter: [], scope: [] } }

/** Validate persisted controls independently so stale preferences cannot break the directory. */
function sanitizePrefs(value: unknown): Prefs {
  const raw = (value ?? {}) as Partial<Prefs>
  const filters = { ...DEFAULT_PREFS.filters }
  for (const [field] of FILTER_FIELDS) {
    const stored = raw.filters?.[field]
    filters[field] = Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === 'string') : []
  }
  return { pageSize: PAGE_SIZES.some((option) => option.value === raw.pageSize) ? raw.pageSize! : 12, filters }
}

/** Render search, multi-select facets, sorting and a paginated saved-value list. */
export function SavedCalibrationDirectory({ results, runs, printers, children }: {
  results: CalibrationResult[]
  runs: CalibrationRun[]
  printers: Printer[]
  children: (rows: CalibrationResult[]) => ReactNode
}) {
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [page, setPage] = useState(1)
  const [prefs, setPrefs] = usePersistentState('printstream.calibration.saved.directory', DEFAULT_PREFS, sanitizePrefs)
  const { sortBy, sortDirection, sortProps } = useDirectorySortState({
    sortByKey: 'printstream.calibration.saved.sort',
    sortDirectionKey: 'printstream.calibration.saved.direction',
    options: SORT_OPTIONS,
    defaultSortBy: 'updatedAt',
    ariaLabel: 'Sort saved calibrations',
    onChange: () => setPage(1)
  })
  const label = (field: FilterField, value: string) => field === 'kind'
    ? calibrationKindLabel(value as CalibrationResult['kind'])
    : field === 'scope' ? (value === 'spool' ? 'Specific spools' : 'Matching filament family')
      : field === 'nozzleDiameter' ? `${value} mm` : value
  const printerNames = useMemo(() => new Map(printers.map((printer) => [printer.id, printer.name])), [printers])
  const modelFacets = useMemo(() => new Map(results.map((result) => {
    const target = result.printerTarget
    const models = !target ? [result.printerModel] : target.scope === 'models' ? target.models
      : printers.filter((printer) => target.printerIds.includes(printer.id)).map((printer) => printer.model)
    return [result.id, models]
  })), [results, printers])
  const facets = useMemo(() => Object.fromEntries(FILTER_FIELDS.map(([field]) => [
    field, [...new Set(results.flatMap((result) => field === 'printerModel' ? modelFacets.get(result.id) ?? [] : [result[field]]))].sort()
  ])) as Record<FilterField, string[]>, [results, modelFacets])
  const visible = useMemo(() => {
    const words = deferredSearch.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const runById = new Map(runs.map((run) => [run.id, run]))
    return results.filter((result) => {
      if (!FILTER_FIELDS.every(([field]) => prefs.filters[field].length === 0
        || (field === 'printerModel' ? modelFacets.get(result.id) ?? [] : [result[field]])
          .some((value) => prefs.filters[field].includes(value)))) return false
      const run = result.runId ? runById.get(result.runId) : null
      const text = [
        calibrationKindLabel(result.kind), calibrationValueLabel(result.kind, result.value),
        calibrationPrinterTargetLabel(result, printerNames), ...(modelFacets.get(result.id) ?? []), result.nozzleDiameter,
        result.scope === 'spool' ? 'Specific spools' : 'Matching filament family',
        result.brand, result.filamentType, result.materialSubtype, result.colorName,
        run?.brand, run?.filamentType, run?.materialSubtype, run?.colorName
      ].filter(Boolean).join(' ').toLowerCase()
      return words.every((word) => text.includes(word))
    }).sort((left, right) => {
      const a = sortBy === 'kind' ? calibrationKindLabel(left.kind) : left[sortBy]
      const b = sortBy === 'kind' ? calibrationKindLabel(right.kind) : right[sortBy]
      return (a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }) || left.id.localeCompare(right.id))
        * (sortDirection === 'asc' ? 1 : -1)
    })
  }, [results, runs, deferredSearch, prefs.filters, sortBy, sortDirection, printerNames, modelFacets])
  useEffect(() => { setPage(1) }, [deferredSearch, prefs])
  const currentPage = Math.min(page, Math.max(1, Math.ceil(visible.length / prefs.pageSize)))
  const start = (currentPage - 1) * prefs.pageSize
  const activeCount = Object.values(prefs.filters).reduce((sum, values) => sum + values.length, 0)
  return (
    <Stack spacing={1}>
      <DirectoryPrimaryToolbar
        pinStorageKey="calibration.saved"
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search saved calibrations…"
        searchAriaLabel="Search saved calibrations"
        {...sortProps}
        pageSizeValue={prefs.pageSize}
        pageSizeOptions={PAGE_SIZES}
        onPageSizeChange={(pageSize) => setPrefs((previous) => ({ ...previous, pageSize }))}
        pageSizeAriaLabel="Saved calibrations per page"
        pageSizeRenderValue={(value) => `${value} per page`}
        filters={{
          activeCount,
          clearDisabled: activeCount === 0,
          onClear: () => setPrefs((previous) => ({ ...previous, filters: DEFAULT_PREFS.filters })),
          children: FILTER_FIELDS.map(([field, title]) => (
            <FormControl key={field}>
              <FormLabel>{title}</FormLabel>
              <Select
                multiple
                value={prefs.filters[field]}
                placeholder="All"
                renderValue={() => prefs.filters[field].length ? prefs.filters[field].map((value) => label(field, value)).join(', ') : null}
                onChange={(_event, values) => setPrefs((previous) => ({ ...previous, filters: { ...previous.filters, [field]: values } }))}
                slotProps={{ listbox: { disablePortal: true } }}
              >
                {facets[field].map((value) => <MultiSelectOption key={value} value={value} selected={prefs.filters[field].includes(value)}>{label(field, value)}</MultiSelectOption>)}
              </Select>
            </FormControl>
          ))
        }}
      />
      {visible.length === 0 ? (
        <EmptyState icon={<ScienceRoundedIcon />} title={results.length ? 'No matching saved values' : 'Nothing saved yet'}
          description={results.length ? 'Try changing your search or filters.' : 'Enter the result on a run to save it.'} compact />
      ) : (
        <PaginatedSection
          showingLabel={`Showing ${start + 1}–${Math.min(start + prefs.pageSize, visible.length)} of ${visible.length}`}
          previousDisabled={currentPage <= 1}
          nextDisabled={start + prefs.pageSize >= visible.length}
          onPrevious={() => setPage(Math.max(1, currentPage - 1))}
          onNext={() => setPage(currentPage + 1)}
        >
          {children(visible.slice(start, start + prefs.pageSize))}
        </PaginatedSection>
      )}
    </Stack>
  )
}
