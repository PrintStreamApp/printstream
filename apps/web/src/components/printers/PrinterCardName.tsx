/**
 * The printer name leading a printer card's header: a button that opens the detail view when
 * `onOpenDetails` is supplied, plain text otherwise. It flexes to fill the header row, which is
 * what pushes every chip that follows it to the trailing edge, but it also reserves a minimum
 * width, because the name matters more than the trailing chips: when the row runs short the
 * header's chip clamp in PrinterCard drops chips instead of letting them crush the name to
 * nothing. Extracted from PrinterCard to keep the header row readable; its counterpart at the
 * trailing edge is PrinterCardHardwareChips.
 */
import { type RefObject } from 'react'
import { Box, Stack } from '@mui/joy'
import type { Printer } from '@printstream/shared'
import { OverflowTooltipText } from '../OverflowTooltipText'

export interface PrinterCardNameProps {
  printer: Printer
  cardRef: RefObject<HTMLElement | null>
  onOpenDetails?: (printer: Printer) => void
}

export function PrinterCardName({ printer, cardRef, onOpenDetails }: PrinterCardNameProps) {
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      // The minWidth is the name's guaranteed floor: chips wrap out of the header's
      // one-line clamp (see PrinterCard) before the name can shrink past it.
      sx={{ minWidth: '4.5rem', flex: 1 }}
    >
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
    </Stack>
  )
}
