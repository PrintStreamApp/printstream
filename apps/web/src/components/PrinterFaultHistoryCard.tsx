/** Standalone reference to a continuous fault, rendered in the server-paged Jobs list. */
import { Card, CardContent, Chip, Stack, Typography } from '@mui/joy'
import type { PrinterFaultHistory } from '@printstream/shared'
import { formatDateTimeInZone } from '../lib/time'
import { PrinterFaultDetails } from './PrinterFaultDetails'
import { PrinterRouteButton } from './PrintJobHistoryCard'

export function PrinterFaultHistoryCard({ period, canDelete }: { period: PrinterFaultHistory; canDelete: boolean }) {
  return <Card variant="outlined" sx={{ height: '100%', minWidth: 0 }}>
    <CardContent>
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', justifyContent: 'space-between' }}>
          <Typography level="title-md"><PrinterRouteButton printerId={period.printerId} label={period.printerName} /></Typography>
          <Chip size="sm" variant="outlined">Printer faults</Chip>
        </Stack>
        <Typography level="body-sm">{period.fault.message ?? period.fault.code}</Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          History from {formatDateTimeInZone(period.startedAt, 'America/Toronto')}
          {period.endedAt ? ` to ${formatDateTimeInZone(period.endedAt, 'America/Toronto')}` : ', ongoing at last observation'}
        </Typography>
        <PrinterFaultDetails faults={[period.fault]} canDelete={canDelete} />
      </Stack>
    </CardContent>
  </Card>
}
