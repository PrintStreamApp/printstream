/**
 * Compact danger Chip that lives in the printer card header next to the
 * actions menu. Shows the error count and opens a Joy `Menu` popover on click
 * with per-error rows. We use a Dropdown rather than a Tooltip because the
 * rows are interactive (support link). Pure presentational component driven
 * entirely by props.
 */
import { useState } from 'react'
import { ClickAwayListener } from '@mui/base/ClickAwayListener'
import { Box, Chip, Dropdown, Link, Menu, MenuButton, Stack, Typography } from '@mui/joy'
import type { PrinterModel, PrinterStatus } from '@printstream/shared'
import { formatHmsDisplayCode, hmsFallbackMessage, hmsSupportSearchUrl } from '../../lib/printersViewHelpers'

type PrinterErrorEntry = NonNullable<PrinterStatus['deviceError']>

export function PrinterErrorChip({
  chipLabel,
  menuTitle,
  errors,
  printerModel,
  printerSerial
}: {
  chipLabel: string
  menuTitle: string
  errors: PrinterStatus['hmsErrors'] | PrinterErrorEntry[]
  printerModel?: PrinterModel
  printerSerial?: string
}) {
  const [open, setOpen] = useState(false)

  return (
    <ClickAwayListener onClickAway={() => setOpen(false)}>
      <Box sx={{ display: 'contents' }}>
        <Dropdown open={open} onOpenChange={(_event, nextOpen) => setOpen(nextOpen)}>
          <MenuButton
            slots={{ root: Chip }}
            slotProps={{
              root: {
                size: 'sm',
                variant: 'solid',
                color: 'danger',
                startDecorator: <Box component="span" aria-hidden sx={{ lineHeight: 1 }}>⚠</Box>,
                sx: { flexShrink: 0, cursor: 'pointer' },
                'aria-label': menuTitle
              }
            }}
          >
            {chipLabel}
          </MenuButton>
          <Menu
            size="sm"
            placement="bottom-end"
            modifiers={[{ name: 'offset', options: { offset: [0, 8] } }]}
            sx={{
              maxWidth: 320,
              p: 1,
              borderColor: 'var(--joy-palette-danger-700)',
              overflow: 'visible',
              '&::before, &::after': {
                content: '""',
                position: 'absolute',
                bottom: '100%',
                right: 12,
                width: 0,
                height: 0,
                borderLeft: '7px solid transparent',
                borderRight: '7px solid transparent'
              },
              '&::before': {
                borderBottom: '7px solid var(--joy-palette-danger-700)'
              },
              '&::after': {
                borderBottom: '7px solid var(--joy-palette-background-popup)',
                marginBottom: '-1px'
              }
            }}
          >
            <Stack
              direction="row"
              alignItems="center"
              spacing={1}
              sx={{ px: 0.5, pb: 0.5 }}
            >
              <Typography level="body-xs" textColor="text.tertiary">
                {menuTitle}
              </Typography>
            </Stack>
            <Stack spacing={0.5} sx={{ px: 0.5 }}>
              {errors.map((error) => (
                <Stack
                  key={error.code}
                  direction="row"
                  spacing={1}
                  alignItems="flex-start"
                  sx={{ minWidth: 0 }}
                >
                  <Stack spacing={0.25} sx={{ flex: 1, minWidth: 0 }}>
                    <Link
                      href={hmsSupportSearchUrl(error.code, error.message, printerModel, printerSerial)}
                      target="_blank"
                      rel="noreferrer noopener"
                      underline="hover"
                      color="danger"
                      level="body-sm"
                      sx={{ whiteSpace: 'normal', alignSelf: 'flex-start' }}
                    >
                      {error.message ?? hmsFallbackMessage(error.code)}
                    </Link>
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                      <Typography level="body-xs" textColor="text.tertiary" sx={{ fontFamily: 'monospace' }}>
                        {formatHmsDisplayCode(error.code)}
                      </Typography>
                    </Stack>
                  </Stack>
                </Stack>
              ))}
            </Stack>
          </Menu>
        </Dropdown>
      </Box>
    </ClickAwayListener>
  )
}
