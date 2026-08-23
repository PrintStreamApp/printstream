/**
 * The static hardware chips at the trailing edge of a printer card's header: the model chip with
 * an IP / Wi-Fi tooltip and the current nozzle-size chip. They render after the live status and
 * plugin chips (and before the actions menu) so transient state reads first and the fixed
 * hardware identity stays right-aligned. Being last in the header's one-line chip clamp
 * (see PrinterCard) also makes them the first to drop when the row runs short, nozzle size,
 * then model, so the printer name and live status keep their room. The chips themselves are the
 * shared PrinterHardwareChips (also rendered on printer picker rows); this wrapper only adds the
 * card's IP/Wi-Fi tooltip.
 */
import { Stack, Typography } from '@mui/joy'
import type { PrinterModel } from '@printstream/shared'
import { PrinterHardwareChips } from './PrinterHardwareChips'

export interface PrinterCardHardwareChipsProps {
  printerModel: PrinterModel
  printerIpAddress: string
  wifiSignalLabel: string
  nozzleSizeLabel: string | null
}

export function PrinterCardHardwareChips({
  printerModel,
  printerIpAddress,
  wifiSignalLabel,
  nozzleSizeLabel
}: PrinterCardHardwareChipsProps) {
  return (
    <PrinterHardwareChips
      model={printerModel}
      modelTooltip={(
        <Stack spacing={0.25} sx={{ py: 0.25 }}>
          <Typography level="body-xs">IP: {printerIpAddress}</Typography>
          <Typography level="body-xs">Wi-Fi signal: {wifiSignalLabel}</Typography>
        </Stack>
      )}
      nozzleSizeLabel={nozzleSizeLabel}
    />
  )
}
