/**
 * Bulk plate-clear confirmation for the printers overview.
 *
 * The action follows the same online-and-idle eligibility as each printer card,
 * confirms the physical attestation once, and keeps failed printers uncleared
 * when only part of the request batch succeeds.
 */
import { Box, Button, Tooltip } from '@mui/joy'
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  PRINTERS_CLEAR_PLATE_PERMISSION,
  extractErrorMessage,
  type Printer,
  type PrinterStatus
} from '@printstream/shared'
import { usePromptDialog } from '../../components/PromptDialogProvider'
import { apiFetch } from '../../lib/apiClient'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import {
  PLATE_CLEARING_STATE_QUERY_KEY,
  findClearablePlatePrinters,
  type PlateClearingStateResponse,
  mergePlateClearingState,
  usePlateClearingStates,
  usePlateClearingSync
} from '../../lib/plateClearing'
import { toast } from '../../lib/toast'

type OverviewPrinter = Pick<Printer, 'id' | 'name'>

function readOverviewPrinters(value: unknown): OverviewPrinter[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is OverviewPrinter => (
    typeof entry === 'object'
    && entry !== null
    && typeof (entry as { id?: unknown }).id === 'string'
    && typeof (entry as { name?: unknown }).name === 'string'
  ))
}

function readPrinterStatuses(value: unknown): Record<string, PrinterStatus> {
  return typeof value === 'object' && value !== null
    ? value as Record<string, PrinterStatus>
    : {}
}

export function PlateClearingOverviewAction({
  printers: rawPrinters,
  statuses: rawStatuses
}: {
  printers?: unknown
  statuses?: unknown
}) {
  usePlateClearingSync()
  const queryClient = useQueryClient()
  const authBootstrapQuery = useAuthBootstrapQuery()
  const { confirm } = usePromptDialog()
  const { clearedByPrinterId, loading } = usePlateClearingStates()
  const printers = readOverviewPrinters(rawPrinters)
  const statuses = readPrinterStatuses(rawStatuses)
  const targets = findClearablePlatePrinters(printers, statuses, clearedByPrinterId)
  const authEnabled = authBootstrapQuery.data?.authEnabled ?? false
  const canClearPlate = authBootstrapQuery.data
    ? !authEnabled || authBootstrapQuery.data.permissions.includes(PRINTERS_CLEAR_PLATE_PERMISSION)
    : false

  const clearAll = useMutation({
    mutationFn: async (targetPrinters: OverviewPrinter[]) => {
      const results = await Promise.allSettled(targetPrinters.map((printer) => (
        apiFetch(`/api/plugins/plate-clearing/state/${printer.id}/clear`, { method: 'POST' })
      )))
      const clearedIds = results.flatMap((result, index) => (
        result.status === 'fulfilled' ? [targetPrinters[index]!.id] : []
      ))

      if (clearedIds.length > 0) {
        queryClient.setQueryData<PlateClearingStateResponse>(
          PLATE_CLEARING_STATE_QUERY_KEY,
          (existing) => clearedIds.reduce(
            (state, printerId) => mergePlateClearingState(state, printerId, true),
            existing
          )
        )
      }

      const failedCount = results.length - clearedIds.length
      if (failedCount > 0) {
        const firstFailure = results.find((result) => result.status === 'rejected')
        if (clearedIds.length === 0 && firstFailure?.status === 'rejected') {
          // Preserve the API error verbatim so the global mutation handler can self-heal a plugin
          // disabled between rendering this action and sending the batch.
          throw firstFailure.reason
        }
        const prefix = clearedIds.length > 0 ? `${clearedIds.length} marked cleared. ` : ''
        const detail = firstFailure?.status === 'rejected'
          ? ` ${extractErrorMessage(firstFailure.reason)}`
          : ''
        throw new Error(`${prefix}Could not mark ${failedCount} printer plate${failedCount === 1 ? '' : 's'} cleared.${detail}`)
      }

      return clearedIds.length
    },
    onSuccess: (count) => {
      toast.success(`${count} printer plate${count === 1 ? '' : 's'} marked cleared`)
    }
  })

  if (authBootstrapQuery.isLoading || loading || !canClearPlate || targets.length === 0) return null

  const markAllCleared = async () => {
    const accepted = await confirm({
      title: targets.length === 1 ? 'Mark this plate cleared?' : `Mark all ${targets.length} plates cleared?`,
      description: `Confirm that the build plate${targets.length === 1 ? '' : 's'} on ${targets.length} printer${targets.length === 1 ? '' : 's'} ${targets.length === 1 ? 'has' : 'have'} been cleared.`,
      confirmLabel: 'Mark all cleared',
      color: 'warning',
      confirmDecorator: <CheckCircleRoundedIcon />
    })
    if (accepted) clearAll.mutate(targets)
  }

  return (
    <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
      <Tooltip title="Confirm every online, idle printer plate that currently needs clearing.">
        <Button
          size="sm"
          color="warning"
          loading={clearAll.isPending}
          startDecorator={<CheckCircleRoundedIcon />}
          onClick={markAllCleared}
        >
          Mark all cleared
        </Button>
      </Tooltip>
    </Box>
  )
}
