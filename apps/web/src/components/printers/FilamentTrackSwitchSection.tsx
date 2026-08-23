/**
 * Read-only Filament Track Switch section: the body of the printer controls
 * dialog's Track switch tab.
 *
 * The FTS is a 2-in/2-out routing module between the AMS units and the two
 * nozzles of a dual-nozzle machine, so an AMS behind it can feed either nozzle.
 * Bambu exposes no command to drive it, routing is chosen by the printer during
 * a print and set up on the printer's own screen, so this surface is purely
 * informational, like `NozzleRackSection`.
 *
 * Rendered only when `status.filamentTrackSwitch` is present; the tab is hidden
 * otherwise.
 */
import { Alert, Box, Chip, Sheet, Stack, Typography } from '@mui/joy'
import AltRouteRoundedIcon from '@mui/icons-material/AltRouteRounded'
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { summarizeFilamentTrackSwitch, type PrinterStatus } from '@printstream/shared'
import { DialogSection } from '../DialogSection'
import {
  buildFilamentTrackSwitchRows,
  filamentTrackSwitchStateColor,
  formatFilamentTrackSwitchState,
  type FilamentTrackSwitchInputRow
} from '../../lib/filamentTrackSwitchHelpers'

function InputRow({ row }: { row: FilamentTrackSwitchInputRow }) {
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0, flexWrap: 'wrap' }}>
      <Chip size="sm" variant="outlined" color="neutral">
        Input {row.input}
      </Chip>
      <Typography level="body-sm" sx={{ minWidth: 0 }} noWrap>
        {row.source ?? 'Not connected'}
      </Typography>
      <ArrowForwardRoundedIcon fontSize="small" aria-hidden />
      <Typography level="body-sm" sx={{ minWidth: 0 }} noWrap>
        {row.target ?? 'Not routed'}
      </Typography>
      {row.unitLetters.length > 0 ? (
        <Typography level="body-xs" textColor="text.tertiary">
          feeds AMS {row.unitLetters.join(', ')}
        </Typography>
      ) : null}
    </Stack>
  )
}

export function FilamentTrackSwitchSection({ status }: { status: PrinterStatus }) {
  const trackSwitch = status.filamentTrackSwitch
  const summary = summarizeFilamentTrackSwitch(status)
  if (!trackSwitch || !summary) return null

  const nozzleCount = status.nozzles.length > 0 ? status.nozzles.length : null
  const rows = buildFilamentTrackSwitchRows(trackSwitch, summary, nozzleCount)

  return (
    <DialogSection title="Filament Track Switch" wrapInSheet={false}>
      <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
        <Stack spacing={1.25}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
            <Chip
              size="sm"
              variant="soft"
              color={filamentTrackSwitchStateColor(summary)}
              startDecorator={<AltRouteRoundedIcon fontSize="inherit" />}
            >
              {formatFilamentTrackSwitchState(summary)}
            </Chip>
            {trackSwitch.filamentPresent != null ? (
              <Typography level="body-xs" textColor="text.tertiary">
                {trackSwitch.filamentPresent ? 'Filament detected at the switch' : 'No filament at the switch'}
              </Typography>
            ) : null}
          </Stack>

          {summary.installed && !summary.ready ? (
            <Alert size="sm" color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
              The Filament Track Switch has not been set up. Finish setup on the printer before loading
              filament or printing.
            </Alert>
          ) : null}

          <Box>
            <Typography level="body-xs" textColor="text.tertiary" sx={{ mb: 0.5 }}>
              Routing
            </Typography>
            <Stack spacing={0.75}>
              {rows.map((row) => (
                <InputRow key={row.input} row={row} />
              ))}
            </Stack>
          </Box>

          <Typography level="body-xs" textColor="text.tertiary">
            An AMS behind the switch can feed either nozzle, so its slots stay available for both. The
            printer chooses the routing during a print; this view is read-only.
          </Typography>
        </Stack>
      </Sheet>
    </DialogSection>
  )
}
