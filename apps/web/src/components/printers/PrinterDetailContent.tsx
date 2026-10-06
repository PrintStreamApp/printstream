/**
 * Renders the selected printer's detail route beneath its page header.
 *
 * PrintersView keeps route selection, statistics range, history state, permission checks, and
 * print-flow dialogs mounted across navigation. This component owns the detail empty state and
 * the order of card, statistics, plugin sections, and history.
 */
import type { ComponentProps } from 'react'
import { Button, Stack } from '@mui/joy'
import type { PrintJob, Printer, PrinterCardContentSettings, PrinterStatus } from '@printstream/shared'
import { EmptyState } from '../EmptyState'
import { Printer3dRoundedIcon } from '../Printer3dRoundedIcon'
import { pageSectionStackSpacing } from '../dashboard/PageSectionHeading'
import { PluginSlot } from '../../plugin/PluginSlot'
import type { LinkedDispatchJob } from '../../lib/trackedPrintJobs'
import type { StatsDateRangeSelection } from '../../lib/statsDateRange'
import { PrinterCard } from './PrinterCard'
import { PrinterDetailStatsSection } from './PrinterDetailStatsSection'
import { PrinterDetailHistorySection } from './PrinterDetailHistorySection'

type SharedCardProps = Omit<ComponentProps<typeof PrinterCard>,
  'printer' | 'status' | 'dispatchLink' | 'activeJob' | 'latestJob' | 'contentSettings' | 'cardsPerRow'>

interface PrinterDetailContentProps {
  printer: Printer | null
  printersLoading: boolean
  hasPrintersError: boolean
  statuses: Record<string, PrinterStatus> | undefined
  dispatchJobsByPrinter: ReadonlyMap<string, LinkedDispatchJob>
  activeJobsByPrinter: ReadonlyMap<string, PrintJob>
  finishedJobsByPrinter: ReadonlyMap<string, PrintJob>
  contentSettings: PrinterCardContentSettings
  cardProps: SharedCardProps
  statsDateRange: StatsDateRangeSelection
  onStatsDateRangeChange: ComponentProps<typeof PrinterDetailStatsSection>['onDateRangeChange']
  historyProps: ComponentProps<typeof PrinterDetailHistorySection>
  onBack: () => void
}

/** Keep the detail sections together without taking ownership of their state. */
export function PrinterDetailContent({
  printer,
  printersLoading,
  hasPrintersError,
  statuses,
  dispatchJobsByPrinter,
  activeJobsByPrinter,
  finishedJobsByPrinter,
  contentSettings,
  cardProps,
  statsDateRange,
  onStatsDateRangeChange,
  historyProps,
  onBack
}: PrinterDetailContentProps) {
  return (
    <Stack spacing={pageSectionStackSpacing}>
      {!printersLoading && !hasPrintersError && !printer && (
        <EmptyState
          icon={<Printer3dRoundedIcon />}
          title="Printer not found"
          description="This printer does not exist or is no longer configured."
          action={
            <Button size="sm" variant="soft" color="neutral" onClick={onBack}>
              Back to printers
            </Button>
          }
        />
      )}

      {printer && (
        <>
          <PrinterCard
            {...cardProps}
            printer={printer}
            status={statuses?.[printer.id]}
            dispatchLink={dispatchJobsByPrinter.get(printer.id)}
            activeJob={activeJobsByPrinter.get(printer.id)}
            latestJob={finishedJobsByPrinter.get(printer.id)}
            contentSettings={contentSettings}
            cardsPerRow={1}
          />
          <PrinterDetailStatsSection
            printerId={printer.id}
            dateRange={statsDateRange}
            onDateRangeChange={onStatsDateRangeChange}
          />
          <PluginSlot
            name="printer.detail.sections"
            context={{ printerId: printer.id, printerName: printer.name, printerModel: printer.model }}
          />
          <PrinterDetailHistorySection {...historyProps} />
        </>
      )}
    </Stack>
  )
}
