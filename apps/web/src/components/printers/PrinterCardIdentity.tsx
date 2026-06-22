/**
 * The leading identity cluster of a printer card's header: the printer name (a button that opens
 * the detail view when `onOpenDetails` is supplied, plain text otherwise), the model chip with an
 * IP / Wi-Fi tooltip, and the current nozzle-size chip. Extracted from PrinterCard to keep the
 * header row readable.
 */
import { type RefObject } from 'react'
import { Box, Chip, Stack, Tooltip, Typography } from '@mui/joy'
import type { Printer } from '@printstream/shared'
import { OverflowTooltipText } from '../OverflowTooltipText'

export interface PrinterCardIdentityProps {
  printer: Printer
  cardRef: RefObject<HTMLElement | null>
  printerIpAddress: string
  wifiSignalLabel: string
  nozzleSizeLabel: string | null
  onOpenDetails?: (printer: Printer) => void
}

export function PrinterCardIdentity({
  printer,
  cardRef,
  printerIpAddress,
  wifiSignalLabel,
  nozzleSizeLabel,
  onOpenDetails
}: PrinterCardIdentityProps) {
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0, flex: 1 }}>
      {onOpenDetails ? (
        <Box
          component="button"
          type="button"
          tabIndex={0}
          onClick={() => onOpenDetails(printer)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onOpenDetails(printer)
            }
          }}
          sx={{
            '--printer-name-color': 'var(--joy-palette-text-secondary)',
            minWidth: 0,
            maxWidth: '100%',
            flexShrink: 1,
            p: 0,
            border: 0,
            background: 'transparent',
            font: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
            '&:hover, &:focus-visible': {
              '--printer-name-color': 'var(--joy-palette-primary-200)'
            },
            '&:focus-visible': {
              outline: '2px solid var(--joy-palette-focusVisible)',
              outlineOffset: '3px',
              borderRadius: 'var(--joy-radius-xs)'
            }
          }}
        >
          <OverflowTooltipText
            level="title-md"
            noWrap
            sx={{ minWidth: 0, maxWidth: '100%', color: 'var(--printer-name-color)', transition: 'color 0.15s ease' }}
            className="printer-name-text"
            text={printer.name}
            observeRef={cardRef}
          />
        </Box>
      ) : (
        <OverflowTooltipText level="title-md" noWrap sx={{ minWidth: 0 }} text={printer.name} observeRef={cardRef} />
      )}
      <Tooltip
        arrow
        placement="top"
        title={(
          <Stack spacing={0.25} sx={{ py: 0.25 }}>
            <Typography level="body-xs">IP: {printerIpAddress}</Typography>
            <Typography level="body-xs">Wi-Fi signal: {wifiSignalLabel}</Typography>
          </Stack>
        )}
      >
        <Chip size="sm" variant="soft" color="neutral" sx={{ flexShrink: 0 }}>{printer.model}</Chip>
      </Tooltip>
      {nozzleSizeLabel && (
        <Tooltip arrow placement="top" title="Current nozzle size">
          <Chip size="sm" variant="soft" color="primary" sx={{ flexShrink: 0 }}>{nozzleSizeLabel}</Chip>
        </Tooltip>
      )}
    </Stack>
  )
}
