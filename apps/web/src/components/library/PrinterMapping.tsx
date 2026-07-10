/**
 * Per-printer AMS / external-spool tray mapping editor for the print dialogs.
 *
 * `PrinterMapping` renders one row per required filament with a slot picker;
 * `SlotOptionLabel` is the color-swatch + loaded-filament + remaining decorator used
 * inside the picker. Pure tray/compatibility derivations live in
 * `../../lib/libraryViewHelpers`; this module only owns the React surface. Extracted
 * verbatim from `PrintModal.tsx` so the print-queue dialog can reuse the exact mapping UI.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Box, Button, Option, Select, Stack, Tooltip, Typography } from '@mui/joy'
import {
  findFilamentCompatibilityIssues,
  formatNozzleLabel,
  type FilamentCompatibilityIssue,
  type Printer,
  type PrinterStatus,
  type ThreeMfProjectFilament
} from '@printstream/shared'
import { filamentBackground, filamentIdentityLabel, filamentTextColor, resolveFilamentIdentity, resolveProjectFilamentColorName } from '../../lib/filamentColor'
import { useSlotFilamentIdentityLookup } from '../../lib/slotFilamentIdentity'
import { formatFilamentRemaining } from '../../lib/filamentSufficiency'
import { getSlotRemainingState } from '../../lib/slotRemaining'
import {
  buildPrinterTrayGroups,
  formatCompatibilityIssue,
  resolvePrinterNozzleCount,
  stopEventPropagation,
  trayHasLoadedFilament,
  trayHasUnknownSpool,
  type PrinterTrayOption
} from '../../lib/libraryViewHelpers'
import { filterTrayGroupsForFilament } from '../../lib/printerTrayMapping'
import { OverflowTooltipText } from '../OverflowTooltipText'
import { AmsSpoolSetupDialog, type AmsSpoolSetupTarget } from '../AmsSpoolSetupDialog'

/**
 * Per-printer tray mapping editor. For each project filament, the user
 * picks which printer tray should feed it. Filaments not
 * actually used by the selected plate are dimmed but still configurable
 * (so the user can pre-set values when later switching plates).
 *
 * Every used filament must have an explicit tray before the print can
 * be dispatched — there is no “auto” fallback because the printer
 * doesn’t actually pick slots itself.
 */
export function PrinterMapping({
  printer,
  status,
  filaments,
  usedGramsById,
  mapping,
  issues,
  onChange
}: {
  printer: Printer
  status: PrinterStatus | undefined
  /** Already narrowed to the filaments to map (see {@link visibleMappingFilaments}). */
  filaments: ThreeMfProjectFilament[]
  usedGramsById: Map<number, number>
  mapping: number[]
  issues: FilamentCompatibilityIssue[]
  onChange: (filamentId: number, tray: number) => void
}) {
  const trayGroups = useMemo(() => buildPrinterTrayGroups(status), [status])
  const printerTrays = useMemo(() => trayGroups.flatMap((group) => group.trays), [trayGroups])
  const nozzleCount = resolvePrinterNozzleCount(printer, status)
  // Spool-setup dialog for unrecognized-but-occupied slots picked in the mapping.
  const [spoolSetupTarget, setSpoolSetupTarget] = useState<AmsSpoolSetupTarget | null>(null)
  const issueByFilamentId = useMemo(
    () => new Map(issues.map((issue) => [issue.filamentId, issue] as const)),
    [issues]
  )

  if (trayGroups.length === 0) {
    return (
      <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 1 }}>
        {printer.name} has no reported printer trays yet — using printer default.
      </Typography>
    )
  }

  return (
    <Stack spacing={0.5} sx={{ mt: 1 }}>
      {filaments.map((filament) => {
        const allowedTrayGroups = filterTrayGroupsForFilament(trayGroups, filament.nozzleId ?? null)
        const slotIndex = filament.id - 1
        const value = mapping[slotIndex] ?? -1
        const selectedTray = printerTrays.find((tray) => tray.mappingValue === value)
        const selectedUnknownTray = selectedTray && trayHasUnknownSpool(selectedTray) ? selectedTray : null
        const grams = usedGramsById.get(filament.id)
        const colorLabel = resolveProjectFilamentColorName({
          color: filament.color,
          filamentName: filament.filamentName,
          filamentType: filament.filamentType
        })
        const issue = issueByFilamentId.get(filament.id)
        const nozzleLabel = formatNozzleLabel(filament.nozzleId ?? null, 'short', nozzleCount)
        const filamentPrimaryLabel = [
          filament.filamentName ?? filament.filamentType ?? 'filament',
          colorLabel
        ].filter(Boolean).join(' · ')
        const filamentMetaLabel = [
          nozzleLabel,
          grams != null ? `${grams.toFixed(grams < 10 ? 1 : 0)}g` : null
        ].filter(Boolean).join(' · ')
        const allowedTrayByValue = new Map(
          allowedTrayGroups.flatMap((group) => group.trays.map((tray) => [tray.mappingValue, tray] as const))
        )
        return (
          <Stack key={filament.id} spacing={0.25}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: '1 1 0', minWidth: 0 }}>
                <Box
                  sx={{
                    width: 32,
                    height: 32,
                    borderRadius: '50%',
                    backgroundColor: filament.color ?? 'var(--joy-palette-neutral-700)',
                    border: '1px solid var(--joy-palette-neutral-700)',
                    flexShrink: 0,
                    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)'
                  }}
                />
                <Stack spacing={0} sx={{ minWidth: 0, flex: '1 1 0' }}>
                  <OverflowTooltipText
                    level="body-xs"
                    sx={{ minWidth: 0 }}
                    noWrap
                    text={filamentPrimaryLabel}
                  />
                  {filamentMetaLabel ? (
                    <OverflowTooltipText
                      level="body-xs"
                      textColor="text.tertiary"
                      sx={{ minWidth: 0 }}
                      noWrap
                      text={filamentMetaLabel}
                    />
                  ) : null}
                </Stack>
              </Stack>
              <Select
                size="sm"
                value={value === -1 ? null : value}
                placeholder="Choose slot…"
                color={value === -1 || issue ? 'warning' : 'neutral'}
                onChange={(_event, next) => next != null && onChange(filament.id, next)}
                renderValue={(option) => {
                  if (!option) return <Typography level="body-xs">Choose slot…</Typography>
                  const tray = allowedTrayByValue.get(option.value as number)
                  if (!tray) return <Typography level="body-xs">Choose slot…</Typography>
                  return (
                    <SlotOptionLabel
                      tray={tray}
                      trays={printerTrays}
                      printerId={printer.id}
                      nozzleCount={nozzleCount}
                      requiredFilamentType={filament.filamentType}
                      requiredNozzleId={filament.nozzleId ?? null}
                      requiredGrams={grams ?? null}
                      autoRefillEnabled={status?.amsSettings.autoRefill === true}
                    />
                  )
                }}
                sx={{ flex: '1 1 0', minWidth: 0 }}
                slotProps={{
                  // Joy's Select button centers its content by default;
                  // the rendered value here is a flex row that needs to
                  // hug the left edge so it visually matches the option
                  // rows in the dropdown.
                  button: {
                    onClick: stopEventPropagation,
                    onMouseDown: stopEventPropagation,
                    onPointerDown: stopEventPropagation,
                    onTouchStart: stopEventPropagation,
                    sx: { textAlign: 'left', justifyContent: 'flex-start', minHeight: 40 }
                  },
                  listbox: {
                    placement: 'bottom-end',
                    modifiers: [{ name: 'equalWidth', enabled: false }],
                    sx: {
                      minWidth: { xs: 'min(92vw, 360px)', sm: 360 },
                      maxWidth: 'calc(100vw - 32px)',
                      width: 'max-content'
                    }
                  }
                }}
              >
                {(() => {
                  const nodes: ReactNode[] = []
                  for (const group of allowedTrayGroups) {
                    if (allowedTrayGroups.length > 0) {
                      nodes.push(
                        <Typography
                          key={`header-${group.key}`}
                          level="body-xs"
                          textColor="text.tertiary"
                          sx={{ px: 1, pt: 0.5, pb: 0.25, fontWeight: 'lg', textTransform: 'uppercase', letterSpacing: '0.05em' }}
                        >
                          {group.label}
                        </Typography>
                      )
                    }
                    for (const tray of group.trays) {
                      nodes.push(
                        <Option key={tray.key} value={tray.mappingValue}>
                          <SlotOptionLabel
                            tray={tray}
                            trays={printerTrays}
                            printerId={printer.id}
                            nozzleCount={nozzleCount}
                            requiredFilamentType={filament.filamentType}
                            requiredNozzleId={filament.nozzleId ?? null}
                            requiredGrams={grams ?? null}
                            autoRefillEnabled={status?.amsSettings.autoRefill === true}
                          />
                        </Option>
                      )
                    }
                  }
                  return nodes
                })()}
              </Select>
            </Stack>
            {issue && (
              <Typography level="body-xs" color="warning" sx={{ pl: 'calc(14px + 8px)' }}>
                {formatCompatibilityIssue(issue, nozzleCount)}
              </Typography>
            )}
            {selectedUnknownTray && (
              <Stack direction="row" spacing={1} alignItems="center" sx={{ pl: 'calc(14px + 8px)' }}>
                <Typography level="body-xs" color="warning">
                  This slot holds an unrecognized spool.
                </Typography>
                <Button
                  size="sm"
                  variant="plain"
                  sx={{ minHeight: 0, py: 0 }}
                  onClick={() => setSpoolSetupTarget({
                    printerId: printer.id,
                    kind: selectedUnknownTray.kind,
                    amsId: selectedUnknownTray.kind === 'ams' ? selectedUnknownTray.amsUnitId ?? 0 : selectedUnknownTray.mappingValue,
                    ...(selectedUnknownTray.kind === 'ams' ? { slotId: selectedUnknownTray.amsSlotId ?? 0 } : {}),
                    label: `${selectedUnknownTray.groupLabel ?? 'Slot'} ${selectedUnknownTray.badgeLabel}`,
                    initial: {
                      filamentType: selectedUnknownTray.filamentType,
                      color: selectedUnknownTray.color,
                      trayInfoIdx: selectedUnknownTray.trayInfoIdx
                    }
                  })}
                >
                  Set up spool…
                </Button>
              </Stack>
            )}
          </Stack>
        )
      })}
      {spoolSetupTarget && (
        <AmsSpoolSetupDialog target={spoolSetupTarget} onClose={() => setSpoolSetupTarget(null)} />
      )}
    </Stack>
  )
}

/** Color swatch + slot label + loaded filament type + remaining estimate, used in slot Selects. */
function SlotOptionLabel({
  tray,
  trays,
  printerId,
  nozzleCount,
  requiredFilamentType,
  requiredNozzleId,
  requiredGrams,
  autoRefillEnabled
}: {
  tray: PrinterTrayOption
  trays: readonly PrinterTrayOption[]
  printerId?: string | null
  nozzleCount?: number | null
  requiredFilamentType?: string | null
  requiredNozzleId?: number | null
  requiredGrams?: number | null
  autoRefillEnabled?: boolean
}) {
  const hasFilament = trayHasLoadedFilament(tray)
  const unknownSpool = trayHasUnknownSpool(tray)
  // Canonical identity label: a tracked spool names the slot as itself
  // ("Michael's PLA · White"); otherwise "Bambu PLA Basic · Jade White" only
  // for genuine (RFID) Bambu trays; custom filament reads as its type + common
  // colour ("PLA · White") — never a fabricated "Bambu <family>" brand claim.
  const resolveSlotFilament = useSlotFilamentIdentityLookup()
  const spool = resolveSlotFilament(
    printerId,
    tray.kind === 'ams' ? tray.amsUnitId ?? null : tray.mappingValue,
    tray.kind === 'ams' ? tray.amsSlotId ?? null : null
  )
  const identity = resolveFilamentIdentity({ ...tray, spool })
  const filamentDetail = unknownSpool
    ? 'Unknown spool'
    : filamentIdentityLabel(identity) ?? 'Empty'
  const remainingState = getSlotRemainingState({
    tray,
    trays,
    requiredFilamentType,
    requiredNozzleId,
    requiredGrams,
    autoRefillEnabled
  })
  const remainGrams = remainingState.remainGrams
  // Remaining: the tracked spool's figure first (filament-manager covers non-RFID
  // custom spools); otherwise only RFID/Bambu spools report a reliable estimate —
  // untracked third-party filament shows nothing rather than a guess.
  const remainingDetail = hasFilament && spool?.remainingGrams != null
    ? formatFilamentRemaining(spool.remainingGrams, spool.remainPercent ?? null)
    : hasFilament && tray.trayUuid != null && tray.remainPercent != null && remainGrams != null
      ? formatFilamentRemaining(remainGrams, tray.remainPercent)
      : null
  const typeMismatch = Boolean(
    requiredFilamentType
    && tray.filamentType
    && findFilamentCompatibilityIssues(
      [{ filamentId: 1, filamentType: requiredFilamentType, filamentName: null, nozzleId: requiredNozzleId ?? null }],
      new Map([[1, { filamentType: tray.filamentType, label: tray.label, nozzleId: tray.nozzleId }]])
    )[0]?.typeMismatch
  )
  const nozzleMismatch = Boolean(
    requiredNozzleId != null
    && (tray.nozzleId == null || requiredNozzleId !== tray.nozzleId)
  )
  const incompatibilityLabel = typeMismatch
    ? `Incompatible material: requires ${requiredFilamentType ?? 'the selected material'}${tray.filamentType ? `, slot has ${tray.filamentType}` : ''}.`
    : nozzleMismatch
      ? `Incompatible nozzle: requires ${formatNozzleLabel(requiredNozzleId ?? null, 'short', nozzleCount) ?? 'the target nozzle'}${tray.nozzleId != null ? `, slot is ${formatNozzleLabel(tray.nozzleId, 'short', nozzleCount)}` : ''}.`
      : null
  const badgeBackground = filamentBackground(identity.colors, tray.color, 'var(--joy-palette-neutral-800)')
  const badgeForeground = filamentTextColor(identity.colors, tray.color, 'var(--joy-palette-text-primary)')
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%', minWidth: 0 }}>
      <Box
        sx={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          border: '1px solid var(--joy-palette-neutral-700)',
          background: badgeBackground,
          color: badgeForeground,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '0.7rem',
          fontWeight: 'lg',
          lineHeight: 1,
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)'
        }}
      >
        {tray.badgeLabel}
      </Box>
      <Box
        sx={{
          minWidth: 0,
          flex: 1,
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto',
          columnGap: 1,
          rowGap: 0.125
        }}
      >
        <Typography level="body-xs" textColor={unknownSpool ? 'warning.300' : 'text.tertiary'} noWrap sx={{ minWidth: 0, gridColumn: '1 / 2' }}>
          {filamentDetail}
        </Typography>
        {incompatibilityLabel && (
          <IncompatibilityWarningGlyph label={incompatibilityLabel} />
        )}
        {remainingDetail && (
          <Stack
            direction="row"
            spacing={0.5}
            alignItems="center"
            sx={{ gridColumn: '1 / 2', minWidth: 0 }}
          >
            <Typography
              level="body-xs"
              textColor={remainingState.insufficient ? 'danger.plainColor' : 'text.tertiary'}
              noWrap
              sx={{ minWidth: 0, fontWeight: remainingState.insufficient ? 'md' : undefined }}
            >
              {remainingDetail}
            </Typography>
            {remainingState.usesAutoRefill && (
              <Tooltip title="AMS auto-refill can continue this filament from another matching AMS slot." variant="soft" size="sm">
                <Box
                  component="span"
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    color: 'primary.plainColor',
                    flexShrink: 0
                  }}
                >
                  <AutoRefillGlyph />
                </Box>
              </Tooltip>
            )}
          </Stack>
        )}
      </Box>
    </Stack>
  )
}

function IncompatibilityWarningGlyph({ label }: { label: string }) {
  return (
    <Tooltip title={label} variant="soft" size="sm">
      <Box
        component="span"
        aria-label={label}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          color: 'warning.plainColor',
          flexShrink: 0,
          gridColumn: '2 / 3',
          gridRow: '1 / span 2',
          alignSelf: 'center',
          justifySelf: 'end',
          cursor: 'help'
        }}
      >
        <WarningGlyph />
      </Box>
    </Tooltip>
  )
}

function AutoRefillGlyph() {
  return (
    <Box
      component="svg"
      viewBox="0 0 24 24"
      aria-hidden
      sx={{ width: 14, height: 14, display: 'block', fill: 'currentColor' }}
    >
      <path d="M12 5a7 7 0 0 1 6.42 4.22H16v2h6V5h-2v2.38A9 9 0 0 0 3 12h2a7 7 0 0 1 7-7zm7 6a7 7 0 0 1-13.42 2.78H8v-2H2v6h2v-2.38A9 9 0 0 0 21 12h-2a7 7 0 0 1-7 7z" />
    </Box>
  )
}

function WarningGlyph() {
  return (
    <Box
      component="svg"
      viewBox="0 0 24 24"
      aria-hidden
      sx={{ width: 16, height: 16, display: 'block', fill: 'currentColor' }}
    >
      <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
    </Box>
  )
}

