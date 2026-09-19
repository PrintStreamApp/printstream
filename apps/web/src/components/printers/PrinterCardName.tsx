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
import { Box, Stack, Tooltip, Typography } from '@mui/joy'
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded'
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
        <Tooltip title={`Open ${printer.name}`} placement="top" arrow>
          <Box
            component="button"
            type="button"
            aria-label={`Open ${printer.name} printer view`}
            onClick={() => onOpenDetails(printer)}
            sx={{
              '--printer-name-color': 'var(--joy-palette-text-secondary)',
              '--printer-name-chevron-opacity': 0.38,
              minWidth: 0,
              maxWidth: '100%',
              flexShrink: 1,
              display: 'flex',
              alignItems: 'center',
              gap: 0.25,
              p: 0,
              border: 0,
              background: 'transparent',
              font: 'inherit',
              textAlign: 'left',
              cursor: 'pointer',
              '&:hover, &:focus-visible': {
                '--printer-name-color': 'var(--joy-palette-primary-200)',
                '--printer-name-chevron-opacity': 0.85,
                '& .printer-name-text': {
                  textDecoration: 'underline',
                  textDecorationThickness: '1px',
                  textUnderlineOffset: '3px'
                },
                '& .printer-name-chevron': {
                  transform: 'translateX(1px)'
                }
              },
              '&:focus-visible': {
                outline: '2px solid var(--joy-palette-focusVisible)',
                outlineOffset: '3px',
                borderRadius: 'var(--joy-radius-xs)'
              }
            }}
          >
            <Typography
              component="span"
              level="title-md"
              noWrap
              className="printer-name-text"
              sx={{
                minWidth: 0,
                color: 'var(--printer-name-color)',
                transition: 'color 0.15s ease'
              }}
            >
              {printer.name}
            </Typography>
            <ChevronRightRoundedIcon
              className="printer-name-chevron"
              style={{
                flexShrink: 0,
                fontSize: 18,
                color: 'var(--joy-palette-text-tertiary)',
                opacity: 'var(--printer-name-chevron-opacity)',
                transition: 'opacity 0.15s ease, transform 0.15s ease'
              }}
            />
          </Box>
        </Tooltip>
      ) : (
        <OverflowTooltipText level="title-md" noWrap sx={{ minWidth: 0 }} text={printer.name} observeRef={cardRef} />
      )}
    </Stack>
  )
}
