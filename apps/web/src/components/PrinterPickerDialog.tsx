/**
 * The one printer picker. Every surface that asks "which machine?" renders THIS — the slice
 * settings sidebar, the queue's start dialog, and anything added later — so a farm is searched,
 * filtered, grouped and sorted the same way wherever it is chosen from.
 *
 * Composed like the other directory pickers (`MaterialPickerDialog`, the library file picker):
 * `DirectoryPrimaryToolbar` + `PaginatedSection` inside a `ScrollableModalDialog`. That is what
 * makes it usable at farm scale; an inline `Select` or autocomplete gives fifty machines one
 * cramped line with no way to narrow them.
 *
 * Callers supply ENTRIES rather than bare printers, so a surface that knows more about a machine
 * can say so without this component learning about queues, slicing or calibration: `meta` renders
 * per-row (readiness chips), `rank` orders a "best match" sort, `disabled` blocks a row. It stays
 * a core component — plugins may import it, it must never import them.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, DialogActions, DialogTitle, FormControl, FormLabel, Select, Sheet, Stack, Typography } from '@mui/joy'
import type { Printer } from '@printstream/shared'
import { BackAwareModal as Modal } from './BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'
import { DirectoryPrimaryToolbar } from './DirectoryToolbar'
import { MultiSelectOption } from './MultiSelectOption'
import { PaginatedSection } from './PaginationFooter'
import { EmptyState } from './EmptyState'
import { Printer3dRoundedIcon } from './Printer3dRoundedIcon'
import { formatPrinterModelLabel } from '../lib/slicingPresetMatching'

/** One selectable machine, plus whatever the calling surface knows about it. */
export interface PrinterPickerEntry {
  printer: Printer
  /** Right-aligned per-row content — readiness chips, status, anything the caller can judge. */
  meta?: ReactNode
  /** Lower sorts first under "Best match". Absent everywhere hides that sort option entirely. */
  rank?: number
  /** Why this machine cannot be chosen. Present = the row is disabled and says so. */
  disabledReason?: string
}

const PAGE_SIZE_OPTIONS = [10, 25, 50].map((value) => ({ value, label: `${value} per page` }))
type PrinterSort = 'match' | 'name' | 'model'

export function PrinterPickerDialog({
  open,
  onClose,
  entries,
  selectedPrinterId,
  onSelect,
  title = 'Choose a printer',
  anyOption
}: {
  open: boolean
  onClose: () => void
  entries: PrinterPickerEntry[]
  selectedPrinterId: string | null
  /** Null only reaches here when `anyOption` is set — see its docs. */
  onSelect: (printer: Printer | null) => void
  title?: string
  /**
   * Offers a leading "no specific machine" row. Not an empty state: for the slice settings that
   * choice means "slice for the selected model", which is a real target. Omit where a surface
   * genuinely requires a machine (starting a print).
   */
  anyOption?: { label: string; description?: string }
}) {
  const [search, setSearch] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [group, setGroup] = useState<'none' | 'model'>('model')
  const hasRanks = entries.some((entry) => entry.rank != null)
  const [sort, setSort] = useState<PrinterSort>(hasRanks ? 'match' : 'name')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  const [pageSize, setPageSize] = useState(25)
  const [page, setPage] = useState(1)

  const modelFacets = useMemo(
    () => Array.from(new Set(entries.map((entry) => formatPrinterModelLabel(entry.printer.model)))).sort(),
    [entries]
  )

  const filtered = useMemo(() => {
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return entries.filter((entry) => {
      const modelLabel = formatPrinterModelLabel(entry.printer.model)
      if (models.length > 0 && !models.includes(modelLabel)) return false
      if (terms.length === 0) return true
      // Address included on purpose: on a farm of identically-named machines it is what tells
      // them apart, and it is what an operator has in front of them.
      const haystack = [entry.printer.name, modelLabel, entry.printer.model, entry.printer.host]
        .filter(Boolean).join(' ').toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
  }, [entries, search, models])

  const sorted = useMemo(() => {
    const factor = direction === 'asc' ? 1 : -1
    const byName = (a: PrinterPickerEntry, b: PrinterPickerEntry) => a.printer.name.localeCompare(b.printer.name)
    if (sort === 'match' && hasRanks) {
      return [...filtered].sort((a, b) => factor * ((a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || byName(a, b)))
    }
    if (sort === 'model') {
      return [...filtered].sort((a, b) => factor * (
        formatPrinterModelLabel(a.printer.model).localeCompare(formatPrinterModelLabel(b.printer.model)) || byName(a, b)
      ))
    }
    return [...filtered].sort((a, b) => factor * byName(a, b))
  }, [filtered, sort, direction, hasRanks])

  const total = sorted.length
  const start = (page - 1) * pageSize
  const pageItems = sorted.slice(start, start + pageSize)

  useEffect(() => {
    setPage(1)
  }, [search, models, sort, direction, pageSize])

  const sortOptions = useMemo(() => [
    ...(hasRanks ? [{ value: 'match' as const, label: 'Best match' }] : []),
    { value: 'name' as const, label: 'Name' },
    { value: 'model' as const, label: 'Model' }
  ], [hasRanks])

  // Group headings are drawn from the PAGE, so a heading never promises rows the page does not
  // hold. Grouping by model is the default because a farm is usually rows of the same machine.
  const groupedPage = useMemo(() => {
    if (group === 'none') return [{ label: null as string | null, items: pageItems }]
    const byModel = new Map<string, PrinterPickerEntry[]>()
    for (const entry of pageItems) {
      const label = formatPrinterModelLabel(entry.printer.model)
      const bucket = byModel.get(label)
      if (bucket) bucket.push(entry)
      else byModel.set(label, [entry])
    }
    return [...byModel.entries()].map(([label, items]) => ({ label, items }))
  }, [group, pageItems])

  const choose = (printer: Printer | null) => {
    onSelect(printer)
    onClose()
  }

  return (
    <Modal open={open} onClose={onClose}>
      <ScrollableModalDialog sx={{ maxWidth: 640, width: '100%' }}>
        <DialogTitle>{title}</DialogTitle>
        <Stack spacing={1.5} sx={{ pt: 1, minHeight: 0, flex: 1 }}>
          <DirectoryPrimaryToolbar
            pinStorageKey="printer-picker"
            compactControls
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search printers…"
            searchAriaLabel="Search printers by name, model or address"
            filters={modelFacets.length > 1 ? {
              activeCount: models.length,
              onClear: () => setModels([]),
              clearDisabled: models.length === 0,
              children: (
                <FormControl>
                  <FormLabel>Model</FormLabel>
                  <Select
                    multiple
                    value={models}
                    onChange={(_event, value) => setModels(value)}
                    placeholder="All models"
                    renderValue={() => (models.length === 0 ? null : models.join(', '))}
                    slotProps={{ listbox: { disablePortal: true } }}
                  >
                    {modelFacets.map((model) => (
                      <MultiSelectOption key={model} value={model} selected={models.includes(model)}>{model}</MultiSelectOption>
                    ))}
                  </Select>
                </FormControl>
              )
            } : undefined}
            grouping={modelFacets.length > 1 ? {
              value: group,
              onChange: (value) => setGroup(value),
              options: [
                { value: 'model', label: 'Group by model' },
                { value: 'none', label: 'No grouping' }
              ]
            } : undefined}
            pageSizeValue={pageSize}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            onPageSizeChange={setPageSize}
            pageSizeAriaLabel="Printers per page"
            pageSizeRenderValue={(value) => `${value} per page`}
            sortValue={sort}
            sortOptions={sortOptions}
            onSortValueChange={(value) => setSort(value as PrinterSort)}
            sortDirection={direction}
            onSortDirectionChange={setDirection}
            sortAriaLabel="Sort printers"
          />
          <ScrollableDialogBody>
            <Stack spacing={0.75}>
              {anyOption && (
                <PrinterPickerRow
                  selected={!selectedPrinterId}
                  title={anyOption.label}
                  subtitle={anyOption.description}
                  onClick={() => choose(null)}
                />
              )}
              {total === 0 ? (
                <EmptyState
                  compact
                  icon={<Printer3dRoundedIcon />}
                  title={entries.length === 0 ? 'No printers yet' : 'No matching printers'}
                  description={entries.length === 0
                    ? 'Add a printer to choose one here.'
                    : 'Try a different search, or clear the model filter.'}
                />
              ) : (
                <PaginatedSection
                  showingLabel={`Showing ${start + 1}–${Math.min(start + pageSize, total)} of ${total}`}
                  previousDisabled={page <= 1}
                  nextDisabled={start + pageSize >= total}
                  onPrevious={() => setPage((current) => Math.max(1, current - 1))}
                  onNext={() => setPage((current) => current + 1)}
                >
                  <Stack spacing={0.75}>
                    {groupedPage.map((bucket) => (
                      <Stack key={bucket.label ?? 'all'} spacing={0.5}>
                        {bucket.label && (
                          <Typography level="body-xs" textColor="text.tertiary" sx={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                            {bucket.label}
                          </Typography>
                        )}
                        {bucket.items.map((entry) => (
                          <PrinterPickerRow
                            key={entry.printer.id}
                            selected={entry.printer.id === selectedPrinterId}
                            title={entry.printer.name}
                            subtitle={entry.disabledReason ?? entry.printer.host}
                            meta={entry.meta}
                            disabled={Boolean(entry.disabledReason)}
                            onClick={() => choose(entry.printer)}
                          />
                        ))}
                      </Stack>
                    ))}
                  </Stack>
                </PaginatedSection>
              )}
            </Stack>
          </ScrollableDialogBody>
        </Stack>
        <DialogActions buttonFlex="0 1 auto" sx={{ pt: 1, justifyContent: 'flex-end' }}>
          <Button type="button" variant="plain" color="neutral" onClick={onClose}>Cancel</Button>
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
  )
}

/** One row. Kept file-local: it is presentational and has no caller but this picker. */
function PrinterPickerRow({
  selected,
  title,
  subtitle,
  meta,
  disabled,
  onClick
}: {
  selected: boolean
  title: string
  subtitle?: ReactNode
  meta?: ReactNode
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <Sheet
      variant="outlined"
      onClick={disabled ? undefined : onClick}
      sx={{
        p: 1,
        borderRadius: 'sm',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        borderColor: selected ? 'primary.500' : undefined,
        transition: 'border-color 120ms',
        '&:hover': disabled ? undefined : { borderColor: 'primary.500' }
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" sx={{ minWidth: 0 }}>
        <Stack sx={{ minWidth: 0 }}>
          <Typography level="body-sm" noWrap>{title}</Typography>
          {subtitle && <Typography level="body-xs" textColor="text.tertiary" noWrap>{subtitle}</Typography>}
        </Stack>
        {meta && <Stack sx={{ flexShrink: 0 }}>{meta}</Stack>}
      </Stack>
    </Sheet>
  )
}
