/**
 * Read-only nozzle-changer (rack) section for the printer controls dialog.
 *
 * The H2C has a static left nozzle and a swappable right-side nozzle system: a
 * rack of spare hotends the printer swaps automatically during prints. Bambu
 * exposes no manual "load nozzle N" command, so this surface is informational —
 * it lists the mounted and parked hotends and the current changer state.
 *
 * Rendered only when `status.nozzleRack` is present (H2C only).
 */
import { Box, Chip, Sheet, Stack, Typography } from '@mui/joy'
import SwapVertRoundedIcon from '@mui/icons-material/SwapVertRounded'
import type { NozzleRack, NozzleRackSlot } from '@printstream/shared'
import { DialogSection } from '../DialogSection'
import { formatNozzleRackStatus, formatNozzleSlotHardware, summarizeNozzleRack } from '../../lib/nozzleRackHelpers'

function NozzleRow({ slot }: { slot: NozzleRackSlot }) {
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
      <Box
        aria-hidden
        sx={{
          width: 12,
          height: 12,
          borderRadius: '50%',
          flexShrink: 0,
          border: '1px solid',
          borderColor: 'neutral.outlinedBorder',
          backgroundColor: slot.loadedFilamentColor ?? 'transparent'
        }}
      />
      <Typography level="body-sm" sx={{ minWidth: 0 }} noWrap>
        {formatNozzleSlotHardware(slot)}
      </Typography>
      {slot.wear != null ? (
        <Typography level="body-xs" textColor="text.tertiary">
          wear {slot.wear}
        </Typography>
      ) : null}
    </Stack>
  )
}

export function NozzleRackSection({ rack }: { rack: NozzleRack }) {
  const summary = summarizeNozzleRack(rack)

  return (
    <DialogSection title="Nozzle changer" wrapInSheet={false}>
      <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
        <Stack spacing={1.25}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
            <Chip
              size="sm"
              variant="soft"
              color={summary.changing ? 'primary' : 'neutral'}
              startDecorator={<SwapVertRoundedIcon fontSize="inherit" />}
            >
              {formatNozzleRackStatus(rack.status)}
            </Chip>
            <Typography level="body-xs" textColor="text.tertiary">
              {summary.mounted.length} mounted · {summary.spares.length} in rack
            </Typography>
          </Stack>

          {summary.mounted.length > 0 ? (
            <Box>
              <Typography level="body-xs" textColor="text.tertiary" sx={{ mb: 0.5 }}>
                Mounted
              </Typography>
              <Stack spacing={0.75}>
                {summary.mounted.map((slot) => (
                  <NozzleRow key={`mounted-${slot.nozzleId}`} slot={slot} />
                ))}
              </Stack>
            </Box>
          ) : null}

          {summary.spares.length > 0 ? (
            <Box>
              <Typography level="body-xs" textColor="text.tertiary" sx={{ mb: 0.5 }}>
                In rack
              </Typography>
              <Stack spacing={0.75}>
                {summary.spares.map((slot) => (
                  <NozzleRow key={`rack-${slot.nozzleId}`} slot={slot} />
                ))}
              </Stack>
            </Box>
          ) : null}

          <Typography level="body-xs" textColor="text.tertiary">
            The printer swaps nozzles automatically during prints; this view is read-only.
          </Typography>
        </Stack>
      </Sheet>
    </DialogSection>
  )
}
