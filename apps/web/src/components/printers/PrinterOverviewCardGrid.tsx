/**
 * Renders grouped printer cards in the overview directory.
 *
 * PrintersView owns route selection, filtering, pagination, permissions, and the print dialogs.
 * This component keeps the responsive card grid and optional tag selection row together so the
 * overview and detail routes do not share a large rendering branch.
 */
import type { ComponentProps } from 'react'
import { Box, Checkbox, Stack, Typography } from '@mui/joy'
import type { PrintJob, Printer, PrinterCardContentSettings, PrinterStatus } from '@printstream/shared'
import type { PrinterGroup } from '../../lib/printersViewHelpers'
import type { LinkedDispatchJob } from '../../lib/trackedPrintJobs'
import { PrinterCard } from './PrinterCard'

type SharedCardProps = Omit<ComponentProps<typeof PrinterCard>,
  'printer' | 'status' | 'dispatchLink' | 'activeJob' | 'latestJob' | 'contentSettings' | 'compact' | 'cardsPerRow'>

interface PrinterOverviewCardGridProps {
  groups: PrinterGroup[]
  statuses: Record<string, PrinterStatus> | undefined
  dispatchJobsByPrinter: ReadonlyMap<string, LinkedDispatchJob>
  activeJobsByPrinter: ReadonlyMap<string, PrintJob>
  finishedJobsByPrinter: ReadonlyMap<string, PrintJob>
  contentSettings: PrinterCardContentSettings
  cardsPerRow: number
  selection?: {
    selectedIds: ReadonlySet<string>
    onToggle: (printer: Printer) => void
  }
  cardProps: SharedCardProps
}

/** Render the current overview page without owning directory or card action state. */
export function PrinterOverviewCardGrid({
  groups,
  statuses,
  dispatchJobsByPrinter,
  activeJobsByPrinter,
  finishedJobsByPrinter,
  contentSettings,
  cardsPerRow,
  selection,
  cardProps
}: PrinterOverviewCardGridProps) {
  return (
    <Stack spacing={2.5}>
      {groups.map((groupEntry) => (
        <Stack key={groupEntry.key} spacing={groupEntry.label ? 1 : 0}>
          {groupEntry.label && (
            <Typography level="title-sm" textColor="text.tertiary">
              {groupEntry.label} · {groupEntry.printers.length}
            </Typography>
          )}
          <Box
            sx={{
              display: 'grid',
              gap: { xs: 1.5, sm: 2.5 },
              gridTemplateColumns: {
                xs: '1fr',
                sm: `repeat(${cardsPerRow}, minmax(0, 1fr))`
              }
            }}
          >
            {groupEntry.printers.map((printer) => (
              <Stack key={printer.id} spacing={0.5}>
                {selection && (
                  <Checkbox
                    label={`Select ${printer.name}`}
                    checked={selection.selectedIds.has(printer.id)}
                    onChange={() => selection.onToggle(printer)}
                  />
                )}
                <PrinterCard
                  {...cardProps}
                  printer={printer}
                  status={statuses?.[printer.id]}
                  dispatchLink={dispatchJobsByPrinter.get(printer.id)}
                  activeJob={activeJobsByPrinter.get(printer.id)}
                  latestJob={finishedJobsByPrinter.get(printer.id)}
                  contentSettings={contentSettings}
                  compact={cardsPerRow >= 4}
                  cardsPerRow={cardsPerRow}
                />
              </Stack>
            ))}
          </Box>
        </Stack>
      ))}
    </Stack>
  )
}
