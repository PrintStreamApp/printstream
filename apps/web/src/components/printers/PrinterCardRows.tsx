/**
 * Filament source rows for the printer card extracted from
 * `pages/PrintersView.tsx`: `AmsUnitRow` renders one AMS unit's slots (with
 * tooltips and a per-slot edit/load/unload/rescan/reset context menu) and
 * `ExternalSpoolRow` renders an external spool. Both are presentational, driven
 * by status data and optional action callbacks.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, CircularProgress, IconButton, Menu, MenuItem, Stack, Tooltip, Typography } from '@mui/joy'
import EditRoundedIcon from '@mui/icons-material/EditRounded'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import EjectRoundedIcon from '@mui/icons-material/EjectRounded'
import LocalFireDepartmentRoundedIcon from '@mui/icons-material/LocalFireDepartmentRounded'
import { type AmsSlot, type AmsUnit, type ExternalSpool } from '@printstream/shared'
import { AmsSlotTooltipBody, ExternalSpoolTooltipBody } from './FilamentTooltipBodies'
import { useControlledMenuClickAway } from '../../hooks/useControlledMenuClickAway'
import {
  filamentBackground,
  filamentTextColor,
  hasLoadedFilament,
  resolveCompactFilamentTypeLabel,
  resolveFilamentDisplay
} from '../../lib/filamentColor'
import { amsUnitLetter } from '../../lib/printerTrayMapping'
import { withDisabledActionReason } from './printerActionHelpers'
import { PluginSlot } from '../../plugin/PluginSlot'
import {
  externalSpoolLabel,
  filamentPresetLabel,
  formatRemaining,
  humidityLevelLabel
} from '../../lib/printersViewHelpers'

export function AmsUnitRow({
  unit,
  compact = false,
  printerId,
  printerModel,
  onRefresh,
  onOpenDrying,
  onEditSlot,
  onLoadSlot,
  loadSlotDisabledReason,
  onUnloadSlot,
  unloadSlotDisabledReason,
  onRescanSlot,
  rescanSlotDisabledReason,
  onResetSlot,
  slotActionsDisabled = false
}: {
  unit: AmsUnit
  compact?: boolean
  printerId?: string
  printerModel?: string
  onRefresh?: () => void
  onOpenDrying?: () => void
  onEditSlot?: (slot: AmsSlot) => void
  onLoadSlot?: (slot: AmsSlot) => void
  loadSlotDisabledReason?: (slot: AmsSlot) => string | null
  onUnloadSlot?: (slot: AmsSlot) => void
  unloadSlotDisabledReason?: (slot: AmsSlot) => string | null
  onRescanSlot?: (slot: AmsSlot) => void
  rescanSlotDisabledReason?: (slot: AmsSlot) => string | null
  onResetSlot?: (slot: AmsSlot) => void
  slotActionsDisabled?: boolean
}) {
  const contextMenuAnchorRef = useRef<HTMLDivElement | null>(null)
  const tooltipOpenTimerRef = useRef<number | null>(null)
  const tooltipSuppressionTimerRef = useRef<number | null>(null)
  const lastSlotPointerTypeRef = useRef<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ slot: AmsSlot; anchorEl: HTMLDivElement } | null>(null)
  const [activeTooltipSlot, setActiveTooltipSlot] = useState<number | null>(null)
  const [tooltipSuppression, setTooltipSuppression] = useState<{ slot: number; anchorEl: HTMLDivElement } | null>(null)

  const clearPendingTooltipOpen = useCallback(() => {
    if (tooltipOpenTimerRef.current != null) {
      window.clearTimeout(tooltipOpenTimerRef.current)
      tooltipOpenTimerRef.current = null
    }
  }, [])

  const clearTooltipSuppression = useCallback((slot?: number) => {
    setTooltipSuppression((current) => {
      if (!current) return null
      if (slot != null && current.slot !== slot) return current
      return null
    })
  }, [])

  const scheduleSlotTooltipOpen = useCallback((slot: number) => {
    clearPendingTooltipOpen()
    if (contextMenu || tooltipSuppression?.slot === slot) return
    tooltipOpenTimerRef.current = window.setTimeout(() => {
      tooltipOpenTimerRef.current = null
      setActiveTooltipSlot(slot)
    }, 150)
  }, [clearPendingTooltipOpen, contextMenu, tooltipSuppression?.slot])

  const closeSlotTooltip = useCallback((slot: number) => {
    clearPendingTooltipOpen()
    setActiveTooltipSlot((current) => current === slot ? null : current)
  }, [clearPendingTooltipOpen])

  const suppressSlotTooltip = useCallback((slot: number, anchorEl: HTMLDivElement, durationMs = 350) => {
    clearPendingTooltipOpen()
    setActiveTooltipSlot(null)
    setTooltipSuppression({ slot, anchorEl })
    if (tooltipSuppressionTimerRef.current != null) {
      window.clearTimeout(tooltipSuppressionTimerRef.current)
    }
    tooltipSuppressionTimerRef.current = window.setTimeout(() => {
      tooltipSuppressionTimerRef.current = null
      if (!anchorEl.matches(':hover') && document.activeElement !== anchorEl) {
        clearTooltipSuppression(slot)
      }
    }, durationMs)
  }, [clearPendingTooltipOpen, clearTooltipSuppression])

  const closeContextMenu = useCallback(() => {
    clearPendingTooltipOpen()
    if (contextMenu) {
      const suppressedSlot = contextMenu.slot.slot
      const suppressedAnchorEl = contextMenu.anchorEl
      contextMenu.anchorEl.blur()
      suppressSlotTooltip(suppressedSlot, suppressedAnchorEl)
    }
    setContextMenu(null)
    contextMenuAnchorRef.current = null
  }, [clearPendingTooltipOpen, contextMenu, suppressSlotTooltip])

  useEffect(() => () => {
    clearPendingTooltipOpen()
    if (tooltipSuppressionTimerRef.current != null) {
      window.clearTimeout(tooltipSuppressionTimerRef.current)
    }
  }, [clearPendingTooltipOpen])

  useControlledMenuClickAway(Boolean(contextMenu), `ams-slot-context-menu-${unit.unitId}`, closeContextMenu, [contextMenuAnchorRef])

  const openSlotContextMenu = (slot: AmsSlot, anchorEl: HTMLDivElement) => {
    if (!onEditSlot && !onLoadSlot && !onUnloadSlot && !onRescanSlot && !onResetSlot) return
    clearPendingTooltipOpen()
    suppressSlotTooltip(slot.slot, anchorEl)
    contextMenuAnchorRef.current = anchorEl
    setContextMenu({ slot, anchorEl })
  }

  const canOpenSlotTooltipForPointer = (pointerType: string) => (
    pointerType === 'mouse'
    && (typeof window === 'undefined' || window.matchMedia('(hover: hover)').matches)
  )

  return (
    <Stack
      sx={{
        height: '100%',
        p: compact ? { xs: 0.625, sm: 0.75 } : { xs: 0.75, sm: 1 },
        borderRadius: 'sm',
        border: '1px solid var(--joy-palette-neutral-700)',
        backgroundColor: 'var(--joy-palette-background-surface)'
      }}
      spacing={{ xs: 0.5, sm: 0.75 }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
          {/* Truncate the unit label rather than letting it wrap under the
              readouts — narrow (single-slot) unit cards have no vertical room. */}
          <Typography level="body-xs" textColor="text.tertiary" noWrap>AMS {amsUnitLetter(unit.unitId)}</Typography>
        </Stack>
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minHeight: '1rem', flexShrink: 0 }}>
          {unit.temperature != null && (
            <Typography level="body-xs" textColor="text.tertiary" noWrap>
              {`${unit.temperature.toFixed(0)}°`}
            </Typography>
          )}
          {unit.humidityPercent != null ? (
            <Typography level="body-xs" textColor="text.tertiary" noWrap>
              {`${Math.round(unit.humidityPercent)}% RH`}
            </Typography>
          ) : unit.humidityLevel != null ? (
            <Tooltip
              variant="outlined"
              size="sm"
              title={`Humidity level ${unit.humidityLevel}/5 — ${humidityLevelLabel(unit.humidityLevel)} (older AMS units do not report a percentage).`}
            >
              <Typography level="body-xs" textColor="text.tertiary" noWrap>
                {`Lv ${unit.humidityLevel}/5`}
              </Typography>
            </Tooltip>
          ) : null}
          {unit.dryingActive && unit.dryTimeRemainingMinutes != null && unit.dryTimeRemainingMinutes > 0 && (
            <Typography level="body-xs" textColor="warning.plainColor" noWrap>
              {`${formatRemaining(unit.dryTimeRemainingMinutes)} left`}
            </Typography>
          )}
          {unit.supportDrying && onOpenDrying && (
            <Tooltip title={unit.dryingActive ? 'View AMS drying' : 'Start AMS drying'} variant="soft" size="sm">
              <IconButton
                size="sm"
                variant="plain"
                onClick={onOpenDrying}
                aria-label={unit.dryingActive ? `View AMS ${amsUnitLetter(unit.unitId)} drying` : `Start AMS ${amsUnitLetter(unit.unitId)} drying`}
                color={unit.dryingActive ? 'warning' : 'neutral'}
                sx={{ minHeight: 0, minWidth: 0, p: 0.25, fontSize: '0.95rem' }}
              >
                <LocalFireDepartmentRoundedIcon fontSize="inherit" />
              </IconButton>
            </Tooltip>
          )}
          {onRefresh && (
            <Tooltip title={`Refresh AMS ${amsUnitLetter(unit.unitId)}`} variant="soft" size="sm">
              <IconButton
                size="sm"
                variant="plain"
                onClick={onRefresh}
                aria-label={`Refresh AMS ${amsUnitLetter(unit.unitId)}`}
                sx={{ minHeight: 0, minWidth: 0, p: 0.25 }}
              >
                <Box component="span" aria-hidden sx={{ fontSize: '0.85rem' }}>↻</Box>
              </IconButton>
            </Tooltip>
          )}
        </Stack>
      </Stack>
      <Stack direction="row" spacing={{ xs: 0.375, sm: 0.5 }}>
        {unit.slots.map((slot) => {
          const contextMenuOpenForSlot = contextMenu?.slot.slot === slot.slot
          const tooltipSuppressedForSlot = tooltipSuppression?.slot === slot.slot
          const isRescanning = slot.isReading
          const slotNumber = slot.slot + 1
          const slotLabel = `${amsUnitLetter(unit.unitId)}${slotNumber}`
          const isActive = slot.active
          const filament = resolveFilamentDisplay(slot)
          const compactFilamentType = resolveCompactFilamentTypeLabel(
            filamentPresetLabel(slot.trayInfoIdx, filament.material, slot.filamentType, { trayUuid: slot.trayUuid })
            ?? slot.filamentType
            ?? filament.material
          )
          const textColor = filamentTextColor(filament.colors, slot.color, 'var(--joy-palette-neutral-400)')
          const slotColorName = filament.name
          const hasColorName = Boolean(slotColorName)
          const centerFilamentType = !hasColorName
          const filamentTypeLabel = compactFilamentType ?? '?'
          const filamentTypeLabelColor = compactFilamentType ? textColor : 'var(--joy-palette-warning-300)'
          const hasFilament = hasLoadedFilament(slot.filamentType, slot.color, slot.colors, {
            trayInfoIdx: slot.trayInfoIdx,
            trayName: slot.trayName,
            trayUuid: slot.trayUuid,
            occupied: slot.occupied,
            remainPercent: slot.remainPercent
          })
          const hasScannedSpool = slot.trayUuid != null
          const remaining = hasScannedSpool && hasFilament && slot.remainPercent != null
            ? Math.max(0, Math.min(100, slot.remainPercent))
            : null
          // Stoplight coloring for the remaining-filament bar so users
          // can spot a near-empty spool at a glance regardless of the
          // swatch underneath.
          const remainingFill =
            remaining == null ? null
              : remaining <= 10 ? 'var(--joy-palette-danger-400)'
              : remaining <= 25 ? 'var(--joy-palette-warning-300)'
              : 'var(--joy-palette-success-400)'
          return (
            <Tooltip
              key={slot.slot}
              variant="outlined"
              placement="top"
              arrow
              disableHoverListener
              disableFocusListener
              disableTouchListener
              open={activeTooltipSlot === slot.slot && !contextMenuOpenForSlot && !tooltipSuppressedForSlot}
              title={<AmsSlotTooltipBody slot={slot} slotLabel={slotLabel} printerId={printerId} amsId={unit.unitId} slotId={slot.slot} />}
              sx={{ maxWidth: 280, p: 0 }}
            >
              <Box
                onClick={onEditSlot ? (event) => {
                  suppressSlotTooltip(slot.slot, event.currentTarget, 1_000)
                  onEditSlot(slot)
                } : undefined}
                onPointerDown={(event) => {
                  lastSlotPointerTypeRef.current = event.pointerType
                  if (event.pointerType !== 'mouse') {
                    suppressSlotTooltip(slot.slot, event.currentTarget, 1_000)
                  }
                }}
                onPointerEnter={(event) => {
                  lastSlotPointerTypeRef.current = event.pointerType
                  if (canOpenSlotTooltipForPointer(event.pointerType)) {
                    scheduleSlotTooltipOpen(slot.slot)
                  }
                }}
                onPointerLeave={() => {
                  lastSlotPointerTypeRef.current = null
                  closeSlotTooltip(slot.slot)
                  clearTooltipSuppression(slot.slot)
                }}
                onFocus={() => {
                  if (lastSlotPointerTypeRef.current == null) {
                    scheduleSlotTooltipOpen(slot.slot)
                  }
                }}
                onBlur={() => {
                  lastSlotPointerTypeRef.current = null
                  closeSlotTooltip(slot.slot)
                  clearTooltipSuppression(slot.slot)
                }}
                onContextMenu={(event) => {
                  if (!onEditSlot && !onLoadSlot && !onUnloadSlot && !onRescanSlot && !onResetSlot) return
                  event.preventDefault()
                  openSlotContextMenu(slot, event.currentTarget)
                }}
                role={onEditSlot ? 'button' : undefined}
                tabIndex={onEditSlot ? 0 : undefined}
                onKeyDown={(event) => {
                  if ((event.key === 'Enter' || event.key === ' ') && onEditSlot) {
                    event.preventDefault()
                    onEditSlot(slot)
                    return
                  }
                  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                    event.preventDefault()
                    openSlotContextMenu(slot, event.currentTarget)
                  }
                }}
                sx={{
                  position: 'relative',
                  flex: 1,
                  minHeight: compact ? { xs: 48, sm: 54 } : { xs: 52, sm: 60 },
                  borderRadius: 'sm',
                  border: isActive
                    ? '2px solid var(--joy-palette-primary-400)'
                    : '1px solid var(--joy-palette-neutral-700)',
                  background: hasFilament
                    ? filamentBackground(filament.colors, slot.color, 'var(--joy-palette-neutral-800)')
                    : 'var(--joy-palette-neutral-800)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                  cursor: onEditSlot ? 'pointer' : 'default',
                  boxShadow: isActive ? '0 0 0 1px rgba(122, 162, 255, 0.35), 0 0 18px rgba(122, 162, 255, 0.18)' : 'none'
                }}
              >
                {isRescanning && (
                  <Box
                    sx={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 'inherit',
                      backgroundColor: 'rgba(7, 10, 16, 0.54)',
                      backdropFilter: 'blur(1px)',
                      zIndex: 1
                    }}
                  >
                    <CircularProgress size="sm" determinate={false} />
                  </Box>
                )}
                <Typography
                  level="body-xs"
                  sx={{
                    position: 'absolute',
                    top: 2,
                    left: 4,
                    color: textColor,
                    opacity: 0.75,
                    fontWeight: 'md',
                    lineHeight: 1
                  }}
                >
                  {slotLabel}
                </Typography>
                {hasFilament ? (
                  <Stack
                    spacing={hasColorName ? 0 : 0.125}
                    alignItems="center"
                    sx={{
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      top: centerFilamentType ? '50%' : 'auto',
                      bottom: centerFilamentType
                        ? 'auto'
                        : hasColorName
                          ? { xs: 9, sm: 11 }
                          : { xs: 11, sm: 14 },
                      transform: centerFilamentType ? 'translateY(-50%)' : 'none',
                      px: 0.75,
                      minWidth: 0,
                      maxWidth: '100%',
                      minHeight: centerFilamentType ? 'auto' : '1.85em'
                    }}
                  >
                    <Typography
                      level="body-xs"
                      noWrap
                      sx={{ color: filamentTypeLabelColor, fontWeight: compactFilamentType ? 'md' : 'lg', maxWidth: '100%', lineHeight: 1.05 }}
                    >
                      {filamentTypeLabel}
                    </Typography>
                    {hasColorName ? (
                      <Typography
                        level="body-xs"
                        noWrap
                        sx={{
                          color: textColor,
                          opacity: 0.78,
                          maxWidth: '100%',
                          lineHeight: 1.05
                        }}
                      >
                        {slotColorName}
                      </Typography>
                    ) : null}
                  </Stack>
                ) : (
                  <Typography
                    level="body-xs"
                    sx={{ color: textColor, fontWeight: 'md' }}
                  >
                    —
                  </Typography>
                )}
                {/* Thin rounded remaining bar across the bottom; the fill
                    is the filament color over a dark track, with a
                    contrasting outline so it reads on any swatch. */}
              {remaining != null && remainingFill != null && (
                <Box
                  aria-hidden
                  sx={{
                    position: 'absolute',
                    left: 4,
                    right: 4,
                    bottom: { xs: 3, sm: 4 },
                    height: { xs: 6, sm: 8 },
                    borderRadius: 4,
                    backgroundColor: 'rgba(0, 0, 0, 0.55)',
                    border: `1px solid ${textColor === '#fff'
                      ? 'rgba(255, 255, 255, 0.15)'
                      : 'rgba(0, 0, 0, 0.22)'}`,
                    overflow: 'hidden',
                    boxSizing: 'border-box'
                  }}
                >
                  <Box
                    sx={{
                      width: `${remaining}%`,
                      height: '100%',
                      backgroundColor: remainingFill,
                      transition: 'width 200ms ease, background-color 200ms ease'
                    }}
                  />
                </Box>
              )}
              </Box>
            </Tooltip>
          )
        })}
      </Stack>
      {contextMenu && (
        <Menu
          id={`ams-slot-context-menu-${unit.unitId}`}
          open
          onClose={closeContextMenu}
          anchorEl={contextMenu.anchorEl}
          placement="bottom-start"
        >
          {onEditSlot && (
            <MenuItem
              disabled={slotActionsDisabled}
              onClick={() => {
                const slot = contextMenu.slot
                closeContextMenu()
                onEditSlot(slot)
              }}
            >
              <EditRoundedIcon /> Edit
            </MenuItem>
          )}
          {onLoadSlot && withDisabledActionReason(
            <MenuItem
              disabled={slotActionsDisabled || Boolean(loadSlotDisabledReason?.(contextMenu.slot))}
              onClick={() => {
                const slot = contextMenu.slot
                closeContextMenu()
                onLoadSlot(slot)
              }}
            >
              <DownloadRoundedIcon /> Load filament
            </MenuItem>,
            slotActionsDisabled ? null : loadSlotDisabledReason?.(contextMenu.slot) ?? null
          )}
          {onUnloadSlot && withDisabledActionReason(
            <MenuItem
              disabled={slotActionsDisabled || Boolean(unloadSlotDisabledReason?.(contextMenu.slot))}
              onClick={() => {
                const slot = contextMenu.slot
                closeContextMenu()
                onUnloadSlot(slot)
              }}
            >
              <EjectRoundedIcon /> Unload filament
            </MenuItem>,
            slotActionsDisabled ? null : unloadSlotDisabledReason?.(contextMenu.slot) ?? null
          )}
          {onRescanSlot && withDisabledActionReason(
            <MenuItem
              disabled={slotActionsDisabled || Boolean(rescanSlotDisabledReason?.(contextMenu.slot))}
              onClick={() => {
                const slot = contextMenu.slot
                closeContextMenu()
                onRescanSlot(slot)
              }}
            >
              <RefreshRoundedIcon /> Rescan
            </MenuItem>,
            slotActionsDisabled ? null : rescanSlotDisabledReason?.(contextMenu.slot) ?? null
          )}
          {onResetSlot && (
            <MenuItem
              disabled={slotActionsDisabled}
              onClick={() => {
                const slot = contextMenu.slot
                closeContextMenu()
                onResetSlot(slot)
              }}
            >
              <RestartAltRoundedIcon /> Reset
            </MenuItem>
          )}
          {printerId && (
            <PluginSlot
              name="printer.amsSlot.menuItems"
              context={{
                printerId,
                printerModel,
                amsId: unit.unitId,
                slotId: contextMenu.slot.slot,
                filamentType: contextMenu.slot.filamentType,
                trayInfoIdx: contextMenu.slot.trayInfoIdx,
                label: `AMS ${amsUnitLetter(unit.unitId)} slot ${contextMenu.slot.slot + 1}${contextMenu.slot.filamentType ? ` (${contextMenu.slot.filamentType})` : ''}`,
                onSelected: closeContextMenu
              }}
            />
          )}
        </Menu>
      )}
    </Stack>
  )
}

export function ExternalSpoolRow({
  spool,
  spoolCount,
  compact = false,
  onEdit,
  printerId
}: {
  spool: ExternalSpool
  spoolCount: number
  compact?: boolean
  onEdit?: () => void
  printerId?: string
}) {
  const label = externalSpoolLabel(spool.amsId, spoolCount)
  const filament = resolveFilamentDisplay(spool)
  const compactFilamentType = resolveCompactFilamentTypeLabel(
    filamentPresetLabel(spool.trayInfoIdx, filament.material, spool.filamentType, { trayUuid: spool.trayUuid })
    ?? spool.filamentType
    ?? filament.material
  )
  const textColor = filamentTextColor(filament.colors, spool.color, 'var(--joy-palette-neutral-400)')
  const filamentTypeLabel = compactFilamentType ?? '?'
  const filamentTypeLabelColor = compactFilamentType ? textColor : 'var(--joy-palette-warning-300)'
  const hasFilament = hasLoadedFilament(spool.filamentType, spool.color, spool.colors, {
    trayInfoIdx: spool.trayInfoIdx,
    trayName: spool.trayName,
    trayUuid: spool.trayUuid,
    occupied: false,
    remainPercent: spool.remainPercent
  })
  const hasScannedSpool = spool.trayUuid != null
  const remaining = hasScannedSpool && hasFilament && spool.remainPercent != null
    ? Math.max(0, Math.min(100, spool.remainPercent))
    : null
  const remainingFill =
    remaining == null ? null
      : remaining <= 15 ? 'var(--joy-palette-danger-400)'
      : remaining <= 35 ? 'var(--joy-palette-warning-300)'
      : 'var(--joy-palette-success-400)'
  const isActive = spool.active

  return (
    <Stack
      sx={{
        height: '100%',
        p: compact ? { xs: 0.625, sm: 0.75 } : { xs: 0.75, sm: 1 },
        borderRadius: 'sm',
        border: isActive ? '1px solid var(--joy-palette-primary-500)' : '1px solid var(--joy-palette-neutral-700)',
        backgroundColor: 'var(--joy-palette-background-surface)'
      }}
      spacing={{ xs: 0.5, sm: 0.75 }}
    >
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
        spacing={1}
        sx={{ minHeight: 'calc(var(--joy-fontSize-xs) * var(--joy-lineHeight-xs) + 0.4rem)' }}
      >
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
          <Typography level="body-xs" textColor="text.tertiary">{label}</Typography>
        </Stack>
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minHeight: '1rem' }}>
          <Box sx={{ width: '0.85rem', height: '0.85rem', visibility: 'hidden', flexShrink: 0 }} />
        </Stack>
      </Stack>
      <Tooltip
        variant="outlined"
        placement="top"
        arrow
        title={<ExternalSpoolTooltipBody spool={spool} label={label} printerId={printerId} />}
        sx={{ maxWidth: 280, p: 0 }}
      >
        <Box
          onClick={onEdit}
          role={onEdit ? 'button' : undefined}
          tabIndex={onEdit ? 0 : undefined}
          onKeyDown={(event) => {
            if (!onEdit) return
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onEdit()
            }
          }}
          sx={{
            position: 'relative',
            minHeight: compact ? { xs: 48, sm: 54 } : { xs: 52, sm: 60 },
            borderRadius: 'sm',
            border: isActive
              ? '2px solid var(--joy-palette-primary-400)'
              : '1px solid var(--joy-palette-neutral-700)',
            background: hasFilament
              ? filamentBackground(filament.colors, spool.color, 'var(--joy-palette-neutral-800)')
              : 'var(--joy-palette-neutral-800)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            cursor: onEdit ? 'pointer' : 'default',
            boxShadow: isActive ? '0 0 0 1px rgba(122, 162, 255, 0.35), 0 0 18px rgba(122, 162, 255, 0.18)' : 'none'
          }}
        >
          <Typography
            level="body-xs"
            sx={{
              color: filamentTypeLabelColor,
              fontWeight: compactFilamentType ? 'md' : 'lg'
            }}
          >
            {filamentTypeLabel}
          </Typography>
          {remaining != null && remainingFill != null && (
            <Box
              aria-hidden
              sx={{
                position: 'absolute',
                left: 4,
                right: 4,
                bottom: { xs: 3, sm: 4 },
                height: { xs: 6, sm: 8 },
                borderRadius: 4,
                backgroundColor: 'rgba(0, 0, 0, 0.55)',
                border: `1px solid ${textColor === '#fff'
                  ? 'rgba(255, 255, 255, 0.15)'
                  : 'rgba(0, 0, 0, 0.22)'}`,
                overflow: 'hidden',
                boxSizing: 'border-box'
              }}
            >
              <Box
                sx={{
                  width: `${remaining}%`,
                  height: '100%',
                  backgroundColor: remainingFill,
                  transition: 'width 200ms ease, background-color 200ms ease'
                }}
              />
            </Box>
          )}
        </Box>
      </Tooltip>
    </Stack>
  )
}
