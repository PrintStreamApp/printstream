/**
 * Tooltip bodies for AMS slots and external spools shown on the printer cards.
 *
 * Each renders a bambuddy-style header band tinted with the loaded filament's
 * actual colour (with a contrasting text colour) plus a detail block with the
 * preset, tray name, and remaining estimate. Both are pure presentational
 * components driven entirely by props.
 */
import { Stack, Typography } from '@mui/joy'
import type { AmsSlot, ExternalSpool } from '@printstream/shared'
import {
  filamentBackground,
  filamentTextColor,
  hasLoadedFilament,
  isRawTrayCode,
  resolveFilamentDisplay,
  resolveFilamentSwatchName
} from '../../lib/filamentColor'
import { filamentPresetLabel } from '../../lib/printersViewHelpers'

export function AmsSlotTooltipBody({ slot, slotLabel }: { slot: AmsSlot; slotLabel: string }) {
  const filament = resolveFilamentDisplay(slot)
  const presetLabel = filamentPresetLabel(slot.trayInfoIdx, filament.material, slot.filamentType)
  const colorName = resolveFilamentSwatchName(slot)
  const hasFilament = hasLoadedFilament(slot.filamentType, slot.color, slot.colors, {
    trayInfoIdx: slot.trayInfoIdx,
    trayName: slot.trayName,
    trayUuid: slot.trayUuid,
    occupied: slot.occupied,
    remainPercent: slot.remainPercent
  })
  const remainGrams = hasFilament && slot.remainPercent != null ? Math.round(slot.remainPercent * 10) : null
  // Header band is the actual filament colour (bambuddy-style). Pick a
  // contrasting text colour so light filaments stay readable. Empty
  // slots fall back to a neutral surface.
  const headerBg = filamentBackground(filament.colors, slot.color, 'var(--joy-palette-neutral-800)')
  const headerFg = filamentTextColor(filament.colors, slot.color, 'var(--joy-palette-text-primary)')
  return (
    <Stack
      sx={{
        minWidth: 220,
        // Clip the colour band to the tooltip's rounded corners. Done
        // here (not on the Tooltip root) so the arrow isn't clipped.
        borderRadius: 'var(--joy-radius-sm)',
        overflow: 'hidden'
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        spacing={1}
        sx={{
          px: 1.25,
          py: 0.75,
          background: headerBg,
          color: headerFg,
          borderBottom: '1px solid rgba(0, 0, 0, 0.25)'
        }}
      >
        <Typography
          level="title-sm"
          sx={{ color: 'inherit', fontWeight: 'lg', flex: 1, minWidth: 0 }}
          noWrap
        >
          {colorName ?? (hasFilament ? 'Custom colour' : 'Empty')}
        </Typography>
        <Typography
          level="body-xs"
          sx={{ color: 'inherit', opacity: 0.85, flexShrink: 0 }}
        >
          Slot {slotLabel}
        </Typography>
      </Stack>
      <Stack spacing={0.5} sx={{ px: 1.25, py: 1 }}>
        {hasFilament ? (
          <>
            <Typography level="body-sm">
              {presetLabel ?? 'Unknown filament'}
            </Typography>
            {slot.trayName && slot.trayName !== slot.filamentType && slot.trayName !== presetLabel && slot.trayName !== colorName && !isRawTrayCode(slot.trayName) && (
              <Typography level="body-xs" textColor="text.tertiary">
                {slot.trayName}
              </Typography>
            )}
            {slot.remainPercent != null && remainGrams != null && (
              <Typography level="body-xs" textColor="text.tertiary">
                {Math.round(slot.remainPercent)}% remaining (~{remainGrams}g)
              </Typography>
            )}
          </>
        ) : (
          <Typography level="body-sm" textColor="text.tertiary">No filament loaded</Typography>
        )}
      </Stack>
    </Stack>
  )
}

export function ExternalSpoolTooltipBody({ spool, label }: { spool: ExternalSpool; label: string }) {
  const filament = resolveFilamentDisplay(spool)
  const presetLabel = filamentPresetLabel(spool.trayInfoIdx, filament.material, spool.filamentType)
  const colorName = resolveFilamentSwatchName(spool)
  const hasFilament = hasLoadedFilament(spool.filamentType, spool.color, spool.colors, {
    trayInfoIdx: spool.trayInfoIdx,
    trayName: spool.trayName,
    trayUuid: spool.trayUuid,
    occupied: false,
    remainPercent: spool.remainPercent
  })
  const remainGrams = hasFilament && spool.remainPercent != null ? Math.round(spool.remainPercent * 10) : null
  const headerBg = filamentBackground(filament.colors, spool.color, 'var(--joy-palette-neutral-800)')
  const headerFg = filamentTextColor(filament.colors, spool.color, 'var(--joy-palette-text-primary)')

  return (
    <Stack
      sx={{
        minWidth: 220,
        borderRadius: 'var(--joy-radius-sm)',
        overflow: 'hidden'
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        spacing={1}
        sx={{
          px: 1.25,
          py: 0.75,
          background: headerBg,
          color: headerFg,
          borderBottom: '1px solid rgba(0, 0, 0, 0.25)'
        }}
      >
        <Typography
          level="title-sm"
          sx={{ color: 'inherit', fontWeight: 'lg', flex: 1, minWidth: 0 }}
          noWrap
        >
          {colorName ?? (hasFilament ? 'Custom colour' : 'Empty')}
        </Typography>
        <Typography level="body-xs" sx={{ color: 'inherit', opacity: 0.85, flexShrink: 0 }}>
          {label}
        </Typography>
      </Stack>
      <Stack spacing={0.5} sx={{ px: 1.25, py: 1 }}>
        {hasFilament ? (
          <>
            <Typography level="body-sm">
              {presetLabel ?? 'Unknown filament'}
            </Typography>
            {spool.trayName && spool.trayName !== spool.filamentType && spool.trayName !== presetLabel && spool.trayName !== colorName && !isRawTrayCode(spool.trayName) && (
              <Typography level="body-xs" textColor="text.tertiary">
                {spool.trayName}
              </Typography>
            )}
            {spool.remainPercent != null && remainGrams != null && (
              <Typography level="body-xs" textColor="text.tertiary">
                {Math.round(spool.remainPercent)}% remaining (~{remainGrams}g)
              </Typography>
            )}
          </>
        ) : (
          <Typography level="body-sm" textColor="text.tertiary">No filament configured</Typography>
        )}
        <Typography level="body-xs" textColor="text.tertiary">
          Manual slot only. RFID scan and auto-detection are not available.
        </Typography>
      </Stack>
    </Stack>
  )
}
