/**
 * Printer, model, and material outcome charts for the workspace Stats view.
 * Bars include cancelled prints, while the success rate uses only successful
 * and failed prints because a user cancellation is not a printer fault.
 * Printer and model views share the workspace-scoped printer outcome query.
 */
import { Alert, Box, Card, CardContent, Divider, Stack, Typography } from '@mui/joy'
import { useQuery } from '@tanstack/react-query'
import type { WorkspaceMaterialOutcomesResponse, WorkspacePrinterOutcomesResponse } from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { compareOutcomes, groupOutcomesByModel, type ReliabilityOutcome } from '../lib/printerReliability'
import { readCurrentWorkspaceScopeKey } from '../lib/workspaceScope'
import { ListSkeleton } from './ListSkeleton'
import { Printer3dRoundedIcon } from './Printer3dRoundedIcon'
import { PrinterHardwareChips } from './printers/PrinterHardwareChips'
import { statsDateRangeSearch, type StatsDateRangeSelection } from '../lib/statsDateRange'

function PrinterOutcomeRow({ outcome }: { outcome: ReliabilityOutcome }) {
  const completed = outcome.successfulPrints + outcome.failedPrints
  const allOutcomes = completed + outcome.cancelledPrints
  const successfulPercent = completed > 0 ? outcome.successfulPrints / completed * 100 : null
  const successfulBarPercent = allOutcomes > 0 ? outcome.successfulPrints / allOutcomes * 100 : 0
  const failedBarPercent = allOutcomes > 0 ? outcome.failedPrints / allOutcomes * 100 : 0
  const cancelledBarPercent = allOutcomes > 0 ? outcome.cancelledPrints / allOutcomes * 100 : 0

  return (
    <Stack spacing={0.75} sx={{ py: 1.25, minWidth: 0 }}>
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        justifyContent="space-between"
        sx={{ minWidth: 0 }}
      >
        <Stack direction="row" spacing={0.75} alignItems="center" useFlexGap sx={{ minWidth: 0, flexWrap: 'wrap' }}>
          <Typography level="title-sm" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>{outcome.name}</Typography>
          {outcome.model && outcome.model !== 'unknown' ? (
            <PrinterHardwareChips model={outcome.model} nozzleSizeLabel={null} />
          ) : null}
          {outcome.printerCount != null ? (
            <Typography level="body-xs" textColor="text.tertiary">
              {outcome.printerCount} {outcome.printerCount === 1 ? 'printer' : 'printers'}
            </Typography>
          ) : null}
        </Stack>
        <Typography
          level="body-sm"
          fontWeight="lg"
          sx={{ flexShrink: 0 }}
          aria-label={successfulPercent == null
            ? 'No successful or failed prints'
            : `${Math.round(successfulPercent)} percent of non-cancelled prints succeeded`}
        >
          {successfulPercent == null ? 'N/A' : `${Math.round(successfulPercent)}%`}
        </Typography>
      </Stack>
      <Box
        role="img"
        aria-label={`${outcome.name}: ${outcome.successfulPrints} successful, ${outcome.failedPrints} failed, and ${outcome.cancelledPrints} cancelled prints`}
        sx={{ display: 'flex', height: 14, borderRadius: 'sm', overflow: 'hidden', bgcolor: 'neutral.softBg' }}
      >
        {successfulBarPercent > 0 ? (
          <Box sx={{ width: `${successfulBarPercent}%`, bgcolor: 'success.500' }} />
        ) : null}
        {failedBarPercent > 0 ? (
          <Box sx={{ width: `${failedBarPercent}%`, bgcolor: 'danger.500' }} />
        ) : null}
        {cancelledBarPercent > 0 ? (
          <Box sx={{ width: `${cancelledBarPercent}%`, bgcolor: 'neutral.500' }} />
        ) : null}
      </Box>
      <Typography level="body-xs" textColor="text.tertiary">
        {outcome.successfulPrints} successful, {outcome.failedPrints} failed
        {outcome.cancelledPrints > 0 ? `, ${outcome.cancelledPrints} cancelled` : ''}
      </Typography>
    </Stack>
  )
}

function ReliabilityLegend() {
  return (
    <Stack direction="row" spacing={2} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap' }}>
      <Stack direction="row" spacing={0.75} alignItems="center">
        <Box sx={{ width: 10, height: 10, borderRadius: 'xs', bgcolor: 'success.500' }} />
        <Typography level="body-xs" textColor="text.tertiary">Successful</Typography>
      </Stack>
      <Stack direction="row" spacing={0.75} alignItems="center">
        <Box sx={{ width: 10, height: 10, borderRadius: 'xs', bgcolor: 'danger.500' }} />
        <Typography level="body-xs" textColor="text.tertiary">Failed</Typography>
      </Stack>
      <Stack direction="row" spacing={0.75} alignItems="center">
        <Box sx={{ width: 10, height: 10, borderRadius: 'xs', bgcolor: 'neutral.500' }} />
        <Typography level="body-xs" textColor="text.tertiary">Cancelled</Typography>
      </Stack>
    </Stack>
  )
}

/** Query once per key; TanStack Query shares the request and result across both cards. */
function usePrinterOutcomesQuery(dateRange: StatsDateRangeSelection) {
  const scopeKey = readCurrentWorkspaceScopeKey()
  return useQuery({
    queryKey: ['workspace-stats', scopeKey, 'printer-outcomes', dateRange?.from ?? 'all', dateRange?.to ?? 'all'],
    queryFn: ({ signal }) => apiFetch<WorkspacePrinterOutcomesResponse>(`/api/stats/printers${statsDateRangeSearch(dateRange)}`, { signal }),
    meta: { suppressGlobalErrorToast: true }
  })
}

function ReliabilityCardSurface({
  title,
  description,
  outcomes,
  isPending,
  isError,
  isSuccess,
  emptyMessage,
  errorMessage = 'Printer outcomes could not be loaded right now.'
}: {
  title: string
  description: string
  outcomes: ReliabilityOutcome[]
  isPending: boolean
  isError: boolean
  isSuccess: boolean
  emptyMessage: string
  errorMessage?: string
}) {
  return (
    <Card variant="outlined" sx={{ minWidth: 0, alignSelf: 'start', maxHeight: 480, overflowY: 'auto' }}>
      <CardContent>
        <Stack spacing={1.25}>
          <Typography level="title-sm" textColor="text.tertiary" startDecorator={<Printer3dRoundedIcon />}>
            {title}
          </Typography>
          <Typography level="body-sm" textColor="text.tertiary">{description}</Typography>
          <ReliabilityLegend />
          {isPending ? <ListSkeleton rows={2} /> : null}
          {isError ? (
            <Alert color="danger" variant="soft">{errorMessage}</Alert>
          ) : null}
          {isSuccess && outcomes.length === 0 ? (
            <Typography level="body-sm" textColor="text.tertiary">{emptyMessage}</Typography>
          ) : null}
          {isSuccess && outcomes.length > 0 ? (
            <Stack divider={<Divider />}>
              {outcomes.map((outcome) => <PrinterOutcomeRow key={outcome.key} outcome={outcome} />)}
            </Stack>
          ) : null}
        </Stack>
      </CardContent>
    </Card>
  )
}

function ReliabilityCard({ byModel, dateRange }: { byModel: boolean; dateRange: StatsDateRangeSelection }) {
  const query = usePrinterOutcomesQuery(dateRange)
  const printers = query.data?.printers ?? []
  const outcomes = byModel
    ? groupOutcomesByModel(printers)
    : printers.map((printer) => ({ ...printer, key: printer.printerId })).sort(compareOutcomes)

  return (
    <ReliabilityCardSurface
      title={byModel ? 'Reliability by model' : 'Printer reliability'}
      description={byModel
        ? 'Recorded outcomes across current printers of each model. Cancellations excluded from success rate.'
        : 'Outcomes in the selected period. Success rate excludes cancellations and manual history.'}
      outcomes={outcomes}
      isPending={query.isPending}
      isError={query.isError}
      isSuccess={query.isSuccess}
      emptyMessage="Add a printer to start tracking outcomes."
    />
  )
}

/** Tracked outcomes across current printers in the selected period. */
export function PrinterReliabilityCard({ dateRange }: { dateRange: StatsDateRangeSelection }) {
  return <ReliabilityCard byModel={false} dateRange={dateRange} />
}

/** The same tracked outcomes grouped by current printer model. */
export function ModelReliabilityCard({ dateRange }: { dateRange: StatsDateRangeSelection }) {
  return <ReliabilityCard byModel dateRange={dateRange} />
}

/** Material outcomes only include jobs with a selected-plate material snapshot. */
export function MaterialReliabilityCard({ dateRange }: { dateRange: StatsDateRangeSelection }) {
  const scopeKey = readCurrentWorkspaceScopeKey()
  const query = useQuery({
    queryKey: ['workspace-stats', scopeKey, 'material-outcomes', dateRange?.from ?? 'all', dateRange?.to ?? 'all'],
    queryFn: ({ signal }) => apiFetch<WorkspaceMaterialOutcomesResponse>(`/api/stats/materials${statsDateRangeSearch(dateRange)}`, { signal }),
    meta: { suppressGlobalErrorToast: true }
  })
  const outcomes: ReliabilityOutcome[] = (query.data?.materials ?? []).map((material) => ({
    key: material.materialType,
    name: material.materialType,
    successfulPrints: material.successfulPrints,
    failedPrints: material.failedPrints,
    cancelledPrints: material.cancelledPrints
  })).sort(compareOutcomes)

  return (
    <ReliabilityCardSurface
      title="Reliability by material"
      description="Available for new library prints with readable plate materials. Multi-material jobs count once for each type; cancellations do not affect success rate."
      outcomes={outcomes}
      isPending={query.isPending}
      isError={query.isError}
      isSuccess={query.isSuccess}
      emptyMessage="Material reliability will appear as new prints finish."
      errorMessage="Material outcomes could not be loaded right now."
    />
  )
}
