/**
 * One row in the print-queue backlog. Presentational: it renders the file/plate,
 * copies count-down, required-filament swatches, target, a live eligibility badge,
 * and the per-item actions. All state + handlers come from {@link QueueSection}.
 */
import { Box, Card, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/joy'
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded'
import PauseRounded from '@mui/icons-material/PauseRounded'
import SendRounded from '@mui/icons-material/SendRounded'
import FactCheckRounded from '@mui/icons-material/FactCheckRounded'
import ReplayRounded from '@mui/icons-material/ReplayRounded'
import EditRounded from '@mui/icons-material/EditRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import KeyboardArrowUpRounded from '@mui/icons-material/KeyboardArrowUpRounded'
import KeyboardArrowDownRounded from '@mui/icons-material/KeyboardArrowDownRounded'
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded'
import { normalizeHexColor, type QueueItem, type QueueItemEligibilitySummary, type QueueRequiredFilament } from '@printstream/shared'
import { humanizeFilamentColorsInText, resolveProjectFilamentColorName } from '../../lib/filamentColor'
import { MatchChip } from './MatchChip'
import type { AspectState } from './printerAspectMatch'

/** Fleet-level match for the item's hardware requirements (does any connected printer satisfy each). */
export interface QueueItemFleetMatch {
  model: AspectState
  nozzle: AspectState
  plate: AspectState
}

interface QueueItemCardProps {
  item: QueueItem
  summary: QueueItemEligibilitySummary
  fleetMatch: QueueItemFleetMatch
  recommendedName: string | null
  canManage: boolean
  busy: boolean
  isFirst: boolean
  isLast: boolean
  onStart: () => void
  onCheck: () => void
  onHold: () => void
  onResume: () => void
  onRequeue: () => void
  onRemove: () => void
  onEdit: () => void
  onMoveUp: () => void
  onMoveDown: () => void
}

export function QueueItemCard(props: QueueItemCardProps) {
  const { item, summary, canManage, busy } = props
  const reorderable = item.status === 'queued' || item.status === 'held'
  const editable = item.status === 'queued' || item.status === 'held' || item.status === 'failed'
  // The start button now opens a dialog (pick printer + map slots), so it's offered for any queued item —
  // even one with no exact-material match, since the dialog lets the user choose the slots themselves.
  const dispatchable = item.status === 'queued'
  // "Check" dry-runs the dispatch (no print) — useful before starting, and to diagnose a failure.
  const checkable = item.status === 'queued' || item.status === 'failed'

  // The name as it shows when printing — drop the .gcode(.3mf)/.3mf extension. The title is the label
  // when one is set; the source filename then moves to its own line (and isn't repeated otherwise).
  const printedName = item.label ?? stripPrintFileExtension(item.fileName)
  const plateLabel = item.plateName ?? (item.kind === '3mf' ? `Plate ${item.plateIndex}` : null)
  const sourceLine = !item.fileAvailable
    ? 'File no longer available'
    : item.label ? stripPrintFileExtension(item.fileName) : null

  return (
    <Card variant="outlined" sx={{ gap: 1 }}>
      <Stack direction="row" spacing={1} alignItems="flex-start" justifyContent="space-between">
        <Box sx={{ minWidth: 0 }}>
          <Typography level="title-sm" noWrap>
            {printedName}
          </Typography>
          {sourceLine ? (
            <Typography level="body-xs" textColor="text.tertiary" noWrap>{sourceLine}</Typography>
          ) : null}
        </Box>
        <Chip size="sm" variant="soft" color={item.remaining > 1 ? 'primary' : 'neutral'}>
          {item.completedCount}/{item.quantity}
        </Chip>
      </Stack>

      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <FilamentSwatches item={item} />
        <TargetChip item={item} />
        {/* Hardware requirements as chips, coloured by whether a connected printer matches (green = a
            printer can run it as-is). Plate matches a printer's manually-set plate. */}
        {plateLabel ? <Chip size="sm" variant="outlined" color="neutral">{plateLabel}</Chip> : null}
        {item.compatibleModels.length > 0 ? <MatchChip label={item.compatibleModels.join('/')} state={props.fleetMatch.model} /> : null}
        {item.nozzleDiameters.length > 0 ? <MatchChip label={`${item.nozzleDiameters.join('/')} mm`} state={props.fleetMatch.nozzle} /> : null}
        {item.plateType ? <MatchChip label={item.plateType} state={props.fleetMatch.plate} /> : null}
      </Stack>

      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap>
        <EligibilityBadge item={item} summary={summary} recommendedName={props.recommendedName} />

        {canManage ? (
          <Stack direction="row" spacing={0.5} alignItems="center">
            {reorderable ? (
              <>
                <Tooltip title="Move up">
                  <span>
                    <IconButton size="sm" variant="plain" disabled={props.isFirst || busy} onClick={props.onMoveUp}>
                      <KeyboardArrowUpRounded />
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip title="Move down">
                  <span>
                    <IconButton size="sm" variant="plain" disabled={props.isLast || busy} onClick={props.onMoveDown}>
                      <KeyboardArrowDownRounded />
                    </IconButton>
                  </span>
                </Tooltip>
              </>
            ) : null}

            <Tooltip title="Remove">
              <span>
                <IconButton size="sm" variant="plain" color="danger" disabled={busy} onClick={props.onRemove}>
                  <DeleteOutlineRounded />
                </IconButton>
              </span>
            </Tooltip>

            {item.status === 'queued' ? (
              <Tooltip title="Hold">
                <span>
                  <IconButton size="sm" variant="plain" disabled={busy} onClick={props.onHold}>
                    <PauseRounded />
                  </IconButton>
                </span>
              </Tooltip>
            ) : null}
            {item.status === 'held' ? (
              <Tooltip title="Resume">
                <span>
                  <IconButton size="sm" variant="plain" disabled={busy} onClick={props.onResume}>
                    <PlayArrowRounded />
                  </IconButton>
                </span>
              </Tooltip>
            ) : null}
            {item.status === 'failed' ? (
              <Tooltip title="Re-queue">
                <span>
                  <IconButton size="sm" variant="plain" disabled={busy} onClick={props.onRequeue}>
                    <ReplayRounded />
                  </IconButton>
                </span>
              </Tooltip>
            ) : null}

            {editable ? (
              <Tooltip title="Edit">
                <span>
                  <IconButton size="sm" variant="plain" disabled={busy} onClick={props.onEdit}>
                    <EditRounded />
                  </IconButton>
                </span>
              </Tooltip>
            ) : null}

            {checkable ? (
              <Tooltip title="Check — see what Start will do (no print)">
                <span>
                  <IconButton size="sm" variant="plain" color="neutral" disabled={busy} onClick={props.onCheck}>
                    <FactCheckRounded />
                  </IconButton>
                </span>
              </Tooltip>
            ) : null}

            <Tooltip title={dispatchable ? 'Start print…' : 'Resume or re-queue this item to start it'}>
              <span>
                <IconButton size="sm" variant="solid" color="primary" disabled={!dispatchable || busy} onClick={props.onStart}>
                  <SendRounded />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        ) : null}
      </Stack>
    </Card>
  )
}

/** Strip the print-source extension so the name matches what shows on the printer. */
function stripPrintFileExtension(name: string): string {
  return name.replace(/\.(gcode\.3mf|gcode|3mf)$/i, '')
}

/**
 * Brand + type identity for a missing required filament, e.g. "Bambu PLA Basic · Jade White" (or just
 * "PLA" when the brand/colour name aren't known). No raw hex — the accompanying swatch carries the colour.
 */
function describeMissingIdentity(filament: QueueRequiredFilament): string {
  const brand = (filament.filamentName ?? '').trim()
  const type = (filament.filamentType ?? '').trim()
  const brandType = brand
    ? (type && brand.toLowerCase().includes(type.toLowerCase()) ? brand : [brand, type].filter(Boolean).join(' '))
    : type
  const colorName = resolveProjectFilamentColorName({ color: filament.color, filamentName: filament.filamentName, filamentType: filament.filamentType })
  return [brandType || 'filament', colorName].filter(Boolean).join(' · ')
}

function FilamentSwatches({ item }: { item: QueueItem }) {
  if (item.requiredFilaments.length === 0) return null
  return (
    <Stack direction="row" spacing={0.5} alignItems="center">
      {item.requiredFilaments.map((filament) => (
        <Tooltip
          key={filament.id}
          title={[
            filament.filamentType ?? 'filament',
            resolveProjectFilamentColorName({ color: filament.color, filamentName: filament.filamentName, filamentType: filament.filamentType }) ?? normalizeHexColor(filament.color)
          ].filter(Boolean).join(' · ')}
        >
          <Box
            sx={{
              width: 14,
              height: 14,
              borderRadius: '50%',
              border: '1px solid',
              borderColor: 'divider',
              bgcolor: filament.color ?? 'neutral.softBg'
            }}
          />
        </Tooltip>
      ))}
    </Stack>
  )
}

function TargetChip({ item }: { item: QueueItem }) {
  if (item.target.kind === 'printer') {
    return <Chip size="sm" variant="outlined">{item.targetPrinterName ?? 'Pinned printer'}</Chip>
  }
  if (item.target.kind === 'model') {
    return <Chip size="sm" variant="outlined">{`Any ${item.target.model ?? 'model'}`}</Chip>
  }
  return <Chip size="sm" variant="outlined" color="neutral">Any printer</Chip>
}

function EligibilityBadge({
  item,
  summary,
  recommendedName
}: {
  item: QueueItem
  summary: QueueItemEligibilitySummary
  recommendedName: string | null
}) {
  switch (item.status) {
    case 'printing':
      return <Chip size="sm" variant="soft" color="success">{recommendedName ? `Printing on ${recommendedName}` : 'Printing'}</Chip>
    case 'dispatching':
      return <Chip size="sm" variant="soft" color="primary">Starting…</Chip>
    case 'done':
      return <Chip size="sm" variant="soft" color="success">Done</Chip>
    case 'failed':
      return <Chip size="sm" variant="soft" color="danger">Last print failed</Chip>
    case 'held':
      return <Chip size="sm" variant="soft" color="neutral">Held</Chip>
    default:
      break
  }
  if (summary.blocked) {
    // Material block: name each missing material by brand + type with a colour swatch (the swatch carries
    // the colour, so we drop the raw hex). Other blocks (model/nozzle/offline) keep their plain reason.
    if (summary.missingFilaments.length > 0) {
      return (
        <Chip size="sm" variant="soft" color="warning" startDecorator={<WarningAmberRounded />}>
          <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap', rowGap: 0.25 }}>
            Needs
            {summary.missingFilaments.map((filament) => (
              <Box key={filament.id} component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.375, minWidth: 0 }}>
                <Box
                  component="span"
                  sx={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    flexShrink: 0,
                    bgcolor: filament.color ?? 'var(--joy-palette-neutral-500)',
                    border: '1px solid var(--joy-palette-neutral-700)'
                  }}
                />
                {describeMissingIdentity(filament)}
              </Box>
            ))}
          </Box>
        </Chip>
      )
    }
    return (
      <Chip size="sm" variant="soft" color="warning" startDecorator={<WarningAmberRounded />}>
        {summary.blockedReason ? humanizeFilamentColorsInText(summary.blockedReason) : 'No eligible printer'}
      </Chip>
    )
  }
  if (summary.waitingForFreePrinter) {
    return <Chip size="sm" variant="soft" color="neutral">Ready — waiting for a free printer</Chip>
  }
  return <Chip size="sm" variant="soft" color="success">{recommendedName ? `Ready → ${recommendedName}` : 'Ready'}</Chip>
}
