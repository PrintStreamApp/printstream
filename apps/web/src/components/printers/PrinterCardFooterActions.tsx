/**
 * The printer-card footer action bar: the split "Print" button (with its library/local-file menu)
 * followed by the plugin/control actions, which collapse into an overflow menu when the row runs
 * out of width. Width measurement and the inline/overflow split are owned by
 * {@link useFooterActionOverflow}; this component only renders the live row and the hidden
 * measurement copy. Extracted from PrinterCard to keep the card body render-focused.
 */
import { Fragment, type MutableRefObject } from 'react'
import { Box, CardActions, CardOverflow, Divider, Dropdown, IconButton, Menu, MenuButton, MenuItem } from '@mui/joy'
import PrintRoundedIcon from '@mui/icons-material/PrintRounded'
import type { Printer } from '@printstream/shared'
import { MoreVertIcon } from './PrinterGlyphs'
import { SplitButton } from '../SplitButton'
import type { PrinterCardFooterAction } from './useFooterActionOverflow'

export interface PrinterCardFooterActionsProps {
  printer: Printer
  footerActions: PrinterCardFooterAction[]
  visibleFooterActions: PrinterCardFooterAction[]
  overflowFooterActions: PrinterCardFooterAction[]
  footerActionRowRef: MutableRefObject<HTMLDivElement | null>
  footerActionMeasureRootRef: MutableRefObject<HTMLDivElement | null>
  footerOverflowMenuMeasureRef: MutableRefObject<HTMLButtonElement | null>
  footerActionMeasureRefs: MutableRefObject<Record<string, HTMLDivElement | null>>
  canShowPrintAction: boolean
  canPrintFromPrinter: boolean
  printDisabledReason: string | null
  onPrint: (printer: Printer) => void
  onPrintLocal: (printer: Printer) => void
}

export function PrinterCardFooterActions({
  printer,
  footerActions,
  visibleFooterActions,
  overflowFooterActions,
  footerActionRowRef,
  footerActionMeasureRootRef,
  footerOverflowMenuMeasureRef,
  footerActionMeasureRefs,
  canShowPrintAction,
  canPrintFromPrinter,
  printDisabledReason,
  onPrint,
  onPrintLocal
}: PrinterCardFooterActionsProps) {
  return (
    <CardOverflow variant="plain">
      <Divider sx={{ mb: 0.5 }} inset="context" />
      <CardActions
        sx={{
          pt: { xs: 1, sm: 1.25 },
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 1
        }}
      >
        <Box
          aria-hidden
          ref={footerActionMeasureRootRef}
          sx={{
            position: 'absolute',
            visibility: 'hidden',
            pointerEvents: 'none',
            height: 0,
            overflow: 'hidden',
            whiteSpace: 'nowrap'
          }}
        >
          {footerActions.map((action) => (
            <Box
              key={`measure:${action.key}`}
              ref={(node) => {
                footerActionMeasureRefs.current[action.key] = node as HTMLDivElement | null
              }}
              sx={{ display: 'inline-flex', mr: 1 }}
            >
              {action.inline}
            </Box>
          ))}
          <IconButton ref={footerOverflowMenuMeasureRef} size="sm" variant="soft" color="neutral" aria-label="Measure footer actions menu">
            <MoreVertIcon />
          </IconButton>
        </Box>
        <Box
          ref={footerActionRowRef}
          sx={{
            width: '100%',
            display: 'flex',
            flexWrap: 'nowrap',
            justifyContent: 'flex-start',
            alignItems: 'center',
            minWidth: 0,
            gap: 1,
              '& .printer-card-action:empty': {
                display: 'none'
              },
            '& .printer-card-action': {
              flexShrink: 0
            },
            '& .printer-card-fill-action': {
              flexShrink: 0
            },
            '& .printer-card-fill-action > .MuiButton-root': {
              width: '100%',
              whiteSpace: 'nowrap'
            },
            '@container printer-card (min-width: 310px) and (max-width: 340px)': {
              '& .printer-card-fill-action': {
                flex: '1 1 0',
                minWidth: 0
              }
            }
          }}
        >
          {canShowPrintAction && (
            <SplitButton
              label="Print"
              onClick={() => onPrint(printer)}
              ariaLabel="print"
              menuAriaLabel="More print options"
              startDecorator={<PrintRoundedIcon />}
              size="sm"
              // Both halves gate together: every print path needs the plate clear
              // and no dispatch in flight. `printDisabledReason` is non-null exactly
              // when the gate fails (see PrinterCard).
              disabled={!canPrintFromPrinter}
              disabledReason={printDisabledReason ?? undefined}
            >
              <MenuItem onClick={() => onPrint(printer)}>Print from library…</MenuItem>
              <MenuItem onClick={() => onPrintLocal(printer)}>Print from local file…</MenuItem>
            </SplitButton>
          )}
          {visibleFooterActions.map((action) => (
            <Box
              key={action.key}
              className={action.fill ? 'printer-card-action printer-card-fill-action' : 'printer-card-action'}
              sx={{ display: 'flex', minWidth: 0 }}
            >
              {action.inline}
            </Box>
          ))}
          {overflowFooterActions.length > 0 && (
            <Dropdown>
              <MenuButton
                slots={{ root: IconButton }}
                slotProps={{ root: { size: 'sm', variant: 'soft', color: 'neutral', 'aria-label': 'More footer actions' } }}
              >
                <MoreVertIcon />
              </MenuButton>
              <Menu size="sm" placement="bottom-end">
                {overflowFooterActions.map((action) => (
                  <Fragment key={action.key}>
                    {action.overflow}
                  </Fragment>
                ))}
              </Menu>
            </Dropdown>
          )}
        </Box>
      </CardActions>
    </CardOverflow>
  )
}
