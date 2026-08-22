/**
 * Overdue-maintenance chip on a printer card header.
 *
 * Renders nothing unless that printer has something due — an always-present
 * "0 due" chip would spend most of its life adding noise to a card that already
 * competes for space.
 *
 * Reads the workspace-wide summary rather than one request per printer: the
 * grid mounts one of these per card, so a per-printer query would fan out to N
 * requests on every visit. All cards share the single cached summary entry.
 */
import BuildRoundedIcon from '@mui/icons-material/BuildRounded'
import { Chip, Tooltip } from '@mui/joy'
import { useQuery } from '@tanstack/react-query'
import { fetchMaintenanceSummary, maintenanceKeys, useMaintenanceSync } from './api'

export function MaintenanceChip(props: Record<string, unknown>) {
  const printerId = typeof props.printerId === 'string' ? props.printerId : null
  useMaintenanceSync()

  const summaryQuery = useQuery({
    queryKey: maintenanceKeys.summary,
    queryFn: ({ signal }) => fetchMaintenanceSummary(signal),
    enabled: printerId != null,
    staleTime: 5 * 60 * 1000
  })

  if (!printerId) return null
  const entry = summaryQuery.data?.printers.find((row) => row.printerId === printerId)
  if (!entry) return null
  if (entry.dueCount === 0 && entry.dueSoonCount === 0) return null

  const due = entry.dueCount > 0
  const count = due ? entry.dueCount : entry.dueSoonCount
  const label = due ? `${count} due` : `${count} due soon`
  const tooltip = entry.printerRequested
    ? 'The printer is asking for maintenance. Open the printer to see what.'
    : `${label} on this printer. Open the printer to see what.`

  return (
    <Tooltip title={tooltip}>
      <Chip
        size="sm"
        variant="soft"
        color={due ? 'danger' : 'warning'}
        startDecorator={<BuildRoundedIcon fontSize="small" />}
      >
        {label}
      </Chip>
    </Tooltip>
  )
}
