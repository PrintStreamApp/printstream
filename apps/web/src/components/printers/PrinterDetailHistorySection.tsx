/**
 * Renders one printer's finished-job directory using the page's persistent
 * history controller. The page keeps the controller mounted across route
 * changes and owns confirmation and print-flow dialogs.
 */
import { Box, FormControl, Select, Stack, Typography } from '@mui/joy'
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded'
import PrintRoundedIcon from '@mui/icons-material/PrintRounded'
import type { PrintJob } from '@printstream/shared'
import type { usePrinterDetailHistory } from '../../hooks/usePrinterDetailHistory'
import { DirectoryPrimaryToolbar } from '../DirectoryToolbar'
import { EmptyState } from '../EmptyState'
import { MultiSelectOption } from '../MultiSelectOption'
import { PaginatedSection } from '../PaginationFooter'
import { PageSectionHeading } from '../dashboard/PageSectionHeading'
import { HISTORY_RESULTS, formatHistoryResultsSummary } from '../../lib/printersViewHelpers'
import { HISTORY_PAGE_SIZE_OPTIONS, HISTORY_SORT_OPTIONS } from '../../lib/printerViewConstants'
import { PrinterHistoryCard } from './PrinterSummaryCards'

type PrinterDetailHistory = ReturnType<typeof usePrinterDetailHistory>

/** Display history controls and actions without owning the page's dialogs. */
export function PrinterDetailHistorySection({
  history,
  jobsLoading,
  jobsError,
  canDeleteJobs,
  canDispatchPrints,
  canControlPrinters,
  canSliceFiles,
  deletingJobId,
  replayingJobId,
  onDelete,
  onReprintLibrary,
  onReprintCalibration,
  onReslice
}: {
  history: PrinterDetailHistory
  jobsLoading: boolean
  jobsError: Error | null
  canDeleteJobs: boolean
  canDispatchPrints: boolean
  canControlPrinters: boolean
  canSliceFiles: boolean
  deletingJobId: string | null
  replayingJobId: string | null
  onDelete: (job: PrintJob) => void
  onReprintLibrary: (job: PrintJob) => void
  onReprintCalibration: (jobId: string) => void
  onReslice: (job: PrintJob) => void
}) {
  const {
    detailHistorySearch,
    setDetailHistorySearch,
    detailHistoryResults,
    setDetailHistoryResults,
    detailHistorySortDirection,
    setDetailHistorySortDirection,
    setDetailHistoryPage,
    detailHistoryPageSize,
    setDetailHistoryPageSize,
    setDetailHistoryViewMode,
    selectedPrinterJobs,
    filteredSelectedPrinterJobs,
    detailHistoryPageCount,
    safeDetailHistoryPage,
    activeDetailHistoryFilterCount,
    effectiveDetailHistoryViewMode,
    visibleSelectedPrinterJobs,
    clearDetailHistoryFilters
  } = history

  return (
    <Stack spacing={1}>
      <PageSectionHeading
        icon={<HistoryRoundedIcon />}
        title="Print history"
        description="Finished, failed, and cancelled prints on this printer."
        count={selectedPrinterJobs.length}
      />

      {jobsLoading && <Typography>Loading history…</Typography>}
      {jobsError && <Typography color="danger">{jobsError.message}</Typography>}

      {!jobsLoading && !jobsError && selectedPrinterJobs.length === 0 && (
        <EmptyState
          compact
          icon={<PrintRoundedIcon />}
          title="No print history yet"
          description="Finished prints will appear here."
        />
      )}

      {selectedPrinterJobs.length > 0 && (
        <DirectoryPrimaryToolbar
          pinStorageKey="printers.history"
          searchValue={detailHistorySearch}
          onSearchChange={(value) => {
            setDetailHistoryPage(0)
            setDetailHistorySearch(value)
          }}
          searchPlaceholder="Search file, result, or time"
          searchAriaLabel="Search printer print history"
          filters={{
            activeCount: activeDetailHistoryFilterCount,
            onClear: clearDetailHistoryFilters,
            clearDisabled: activeDetailHistoryFilterCount === 0,
            children: (
              <FormControl>
                <Typography level="body-sm" textColor="text.tertiary">Results</Typography>
                <Select
                  size="sm"
                  multiple
                  value={detailHistoryResults}
                  onChange={(_event, value) => {
                    setDetailHistoryPage(0)
                    setDetailHistoryResults(value ?? [])
                  }}
                  placeholder="All results"
                  renderValue={() => detailHistoryResults.length === 0
                    ? null
                    : formatHistoryResultsSummary(detailHistoryResults)}
                  slotProps={{ listbox: { disablePortal: true, sx: { maxHeight: 280 } } }}
                >
                  {HISTORY_RESULTS.map((result) => (
                    <MultiSelectOption key={result} value={result} selected={detailHistoryResults.includes(result)}>{result}</MultiSelectOption>
                  ))}
                </Select>
              </FormControl>
            )
          }}
          pageSizeValue={detailHistoryPageSize}
          pageSizeOptions={HISTORY_PAGE_SIZE_OPTIONS.map((value) => ({ value, label: `${value} rows per page` }))}
          onPageSizeChange={(value) => {
            setDetailHistoryPage(0)
            setDetailHistoryPageSize(value)
          }}
          pageSizeAriaLabel="Printer history rows per page"
          pageSizeRenderValue={(value) => `${value} per page`}
          sortValue="date"
          sortOptions={HISTORY_SORT_OPTIONS}
          onSortValueChange={() => undefined}
          sortDirection={detailHistorySortDirection}
          onSortDirectionChange={(direction) => {
            setDetailHistoryPage(0)
            setDetailHistorySortDirection(direction)
          }}
          sortAriaLabel="Sort printer print history by"
          viewMode={effectiveDetailHistoryViewMode}
          onViewModeChange={setDetailHistoryViewMode}
          disableIconModeOnMobile
        />
      )}

      {selectedPrinterJobs.length > 0 && filteredSelectedPrinterJobs.length === 0 && (
        <Typography level="body-sm" textColor="text.tertiary">
          No print history matches the current search or filters.
        </Typography>
      )}

      {filteredSelectedPrinterJobs.length > 0 && (
        <PaginatedSection
          showingLabel={`Showing ${safeDetailHistoryPage * detailHistoryPageSize + 1}-${Math.min(filteredSelectedPrinterJobs.length, (safeDetailHistoryPage + 1) * detailHistoryPageSize)} of ${filteredSelectedPrinterJobs.length}`}
          previousDisabled={safeDetailHistoryPage === 0}
          nextDisabled={safeDetailHistoryPage >= detailHistoryPageCount - 1}
          onPrevious={() => setDetailHistoryPage((current) => Math.max(0, current - 1))}
          onNext={() => setDetailHistoryPage((current) => Math.min(detailHistoryPageCount - 1, current + 1))}
          spacing={1.5}
        >
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: effectiveDetailHistoryViewMode === 'icon'
                ? { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' }
                : 'minmax(0, 1fr)',
              gap: 1.5,
              alignItems: 'stretch'
            }}
          >
            {visibleSelectedPrinterJobs.map((job) => (
              <PrinterHistoryCard
                key={job.id}
                job={job}
                canDeleteJobs={canDeleteJobs}
                canDispatchPrints={canDispatchPrints}
                canControlPrinters={canControlPrinters}
                canSliceFiles={canSliceFiles}
                onReslice={onReslice}
                deletingJobId={deletingJobId}
                replayingJobId={replayingJobId}
                onDelete={(jobId) => {
                  const job = selectedPrinterJobs.find((entry) => entry.id === jobId) ?? null
                  if (job) onDelete(job)
                }}
                onReprintLibrary={onReprintLibrary}
                onReprintCalibration={onReprintCalibration}
              />
            ))}
          </Box>
        </PaginatedSection>
      )}
    </Stack>
  )
}
