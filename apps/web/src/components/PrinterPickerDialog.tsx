/**
 * The one printer picker. Every surface that asks "which machine?" renders THIS, the slice
 * settings sidebar, the queue's start dialog, and anything added later, so a farm is searched,
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
 * a core component: plugins may import it, it must never import them.
 *
 * Machine state and hardware identity are the picker's own: every row carries the card's stage
 * chip (Idle / Printing / Offline) and hardware chips (model, nozzle size, installed plate, via
 * PrinterHardwareChips), read from live statuses the picker subscribes to itself rather than
 * asking callers to plumb them through the entries, so every surface gets identical chips for
 * free, and `meta` stays purely surface-specific. The subscription strips telemetry (see
 * usePrinterStatuses) and every caller mounts this dialog only while it is open, so status ticks
 * cannot thrash a closed picker or its dropdowns.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, Chip, DialogActions, DialogTitle, FormControl, FormLabel, Select, Sheet, Stack, Typography } from '@mui/joy'
import { formatPrinterNozzleSizesLabel, normalizePlateType, resolvePrinterNozzleSizeLabels, type Printer } from '@printstream/shared'
import { BackAwareModal as Modal } from './BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'
import { DirectoryPrimaryToolbar } from './DirectoryToolbar'
import { MultiSelectOption } from './MultiSelectOption'
import { PaginatedSection } from './PaginationFooter'
import { EmptyState } from './EmptyState'
import { Printer3dRoundedIcon } from './Printer3dRoundedIcon'
import { PrinterHardwareChips } from './printers/PrinterHardwareChips'
import { stageLabelColor } from './printerJobProgressTone'
import { usePrinterStatuses } from '../hooks/usePrinterStatuses'
import { formatStageLabel } from '../lib/printersViewHelpers'
import { formatPlateTypeLabel, formatPrinterModelLabel } from '../lib/slicingPresetMatching'

/** One selectable machine, plus whatever the calling surface knows about it. */
export interface PrinterPickerEntry {
  printer: Printer
  /** Right-aligned per-row content: readiness chips, anything the caller can judge. Don't
   * restate stage or hardware identity: the picker renders those chips on every row itself. */
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
  /** Null only reaches here when `anyOption` is set: see its docs. */
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
  const [nozzleSizes, setNozzleSizes] = useState<string[]>([])
  // Ungrouped by default: every row carries its own model chip, so the group headings add
  // little until a farm is large enough that the user reaches for them deliberately.
  const [group, setGroup] = useState<'none' | 'model'>('none')
  const hasRanks = entries.some((entry) => entry.rank != null)
  const [sort, setSort] = useState<PrinterSort>(hasRanks ? 'match' : 'name')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  const [pageSize, setPageSize] = useState(25)
  const [page, setPage] = useState(1)

  const statuses = usePrinterStatuses({ ignoreTelemetry: true })

  /**
   * Per-machine hardware labels, resolved once for the facet list, the search haystack and the
   * row chips. `nozzleLabels` keeps the per-diameter labels (a dual-extruder machine faceted as
   * BOTH "0.4 mm" and "0.2 mm"); `nozzleSizeLabel` is the card's combined one-chip form;
   * `plateTypeLabel` is the manually-set installed plate.
   */
  const hardwareById = useMemo(() => new Map(entries.map(({ printer }) => {
    const status = statuses[printer.id]
    const plateType = normalizePlateType(printer.currentPlateType)
    return [printer.id, {
      nozzleLabels: resolvePrinterNozzleSizeLabels(status, printer.currentNozzleDiameters),
      nozzleSizeLabel: formatPrinterNozzleSizesLabel(status, printer.currentNozzleDiameters),
      plateTypeLabel: plateType ? formatPlateTypeLabel(plateType) : null
    }] as const
  })), [entries, statuses])

  const modelFacets = useMemo(
    () => Array.from(new Set(entries.map((entry) => formatPrinterModelLabel(entry.printer.model)))).sort(),
    [entries]
  )
  const nozzleFacets = useMemo(
    () => Array.from(new Set([...hardwareById.values()].flatMap((hardware) => hardware.nozzleLabels))).sort(),
    [hardwareById]
  )

  const filtered = useMemo(() => {
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return entries.filter((entry) => {
      const modelLabel = formatPrinterModelLabel(entry.printer.model)
      const hardware = hardwareById.get(entry.printer.id)
      const nozzleLabels = hardware?.nozzleLabels ?? []
      if (models.length > 0 && !models.includes(modelLabel)) return false
      if (nozzleSizes.length > 0 && !nozzleLabels.some((label) => nozzleSizes.includes(label))) return false
      if (terms.length === 0) return true
      // Address included on purpose: on a farm of identically-named machines it is what tells
      // them apart, and it is what an operator has in front of them.
      const haystack = [entry.printer.name, modelLabel, entry.printer.model, entry.printer.host, ...nozzleLabels, hardware?.plateTypeLabel]
        .filter(Boolean).join(' ').toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
  }, [entries, search, models, nozzleSizes, hardwareById])

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
  }, [search, models, nozzleSizes, sort, direction, pageSize])

  const sortOptions = useMemo(() => [
    ...(hasRanks ? [{ value: 'match' as const, label: 'Best match' }] : []),
    { value: 'name' as const, label: 'Name' },
    { value: 'model' as const, label: 'Model' }
  ], [hasRanks])

  // Group headings are drawn from the PAGE, so a heading never promises rows the page does not
  // hold. When grouped, the heading takes over the model duty and the rows drop their model chip.
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
            searchAriaLabel="Search printers by name, model, nozzle size, plate or address"
            filters={modelFacets.length > 1 || nozzleFacets.length > 1 ? {
              activeCount: models.length + nozzleSizes.length,
              onClear: () => { setModels([]); setNozzleSizes([]) },
              clearDisabled: models.length === 0 && nozzleSizes.length === 0,
              children: (
                <>
                  {modelFacets.length > 1 && (
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
                  )}
                  {nozzleFacets.length > 1 && (
                    <FormControl>
                      <FormLabel>Nozzle</FormLabel>
                      <Select
                        multiple
                        value={nozzleSizes}
                        onChange={(_event, value) => setNozzleSizes(value)}
                        placeholder="All nozzle sizes"
                        renderValue={() => (nozzleSizes.length === 0 ? null : nozzleSizes.join(', '))}
                        slotProps={{ listbox: { disablePortal: true } }}
                      >
                        {nozzleFacets.map((size) => (
                          <MultiSelectOption key={size} value={size} selected={nozzleSizes.includes(size)}>{size}</MultiSelectOption>
                        ))}
                      </Select>
                    </FormControl>
                  )}
                </>
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
                    : 'Try a different search, or clear the filters.'}
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
                        {bucket.items.map((entry) => {
                          // Under a model group heading the model chip would restate the heading
                          // on every row, so it only renders when grouping is off; the nozzle and
                          // plate chips render whenever the value is known. The stage chip always
                          // renders: unlike the card (empty row = healthy), a picker is where
                          // Idle-vs-Printing-vs-Offline decides the choice.
                          const status = statuses[entry.printer.id]
                          const showModelChip = bucket.label == null
                          const hardware = hardwareById.get(entry.printer.id)
                          return (
                            <PrinterPickerRow
                              key={entry.printer.id}
                              selected={entry.printer.id === selectedPrinterId}
                              title={entry.printer.name}
                              subtitle={entry.disabledReason ?? entry.printer.host}
                              status={(
                                <Chip size="sm" variant="soft" color={stageLabelColor(status)} sx={{ flexShrink: 0 }}>
                                  {formatStageLabel(status)}
                                </Chip>
                              )}
                              meta={entry.meta}
                              hardware={showModelChip || hardware?.nozzleSizeLabel || hardware?.plateTypeLabel ? (
                                <PrinterHardwareChips
                                  model={showModelChip ? entry.printer.model : null}
                                  nozzleSizeLabel={hardware?.nozzleSizeLabel ?? null}
                                  plateTypeLabel={hardware?.plateTypeLabel ?? null}
                                />
                              ) : undefined}
                              disabled={Boolean(entry.disabledReason)}
                              onClick={() => choose(entry.printer)}
                            />
                          )
                        })}
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
  status,
  meta,
  hardware,
  disabled,
  onClick
}: {
  selected: boolean
  title: string
  subtitle?: ReactNode
  /** The machine's live stage chip: leads the cluster, mirroring the card's live-state-first order. */
  status?: ReactNode
  meta?: ReactNode
  /** The machine's fixed identity chips (model, nozzle, plate): rendered after `meta`, mirroring
   * the card's transient-state-first, hardware-last order. */
  hardware?: ReactNode
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
      {/* The chip cluster wraps under the name at phone widths instead of crushing it, a picker
          exists to compare machines, so the chips must stay readable rather than clamp away. */}
      <Stack direction="row" spacing={1} rowGap={0.5} useFlexGap alignItems="center" flexWrap="wrap" sx={{ minWidth: 0 }}>
        <Stack sx={{ minWidth: 0, flex: '1 1 auto' }}>
          <Typography level="body-sm" noWrap>{title}</Typography>
          {subtitle && <Typography level="body-xs" textColor="text.tertiary" noWrap>{subtitle}</Typography>}
        </Stack>
        {(status || meta || hardware) && (
          <Stack direction="row" spacing={0.5} rowGap={0.5} useFlexGap flexWrap="wrap" alignItems="center" justifyContent="flex-end" sx={{ ml: 'auto', minWidth: 0 }}>
            {status}
            {meta}
            {hardware}
          </Stack>
        )}
      </Stack>
    </Sheet>
  )
}
