/**
 * The G-code preview's legend: how the toolpath is coloured, what the colours mean, what is
 * shown, and what the print costs (#92).
 *
 * BambuStudio's equivalent is one floating legend holding all four, and keeping them together is
 * the point: the colour-scheme picker is meaningless without the key beneath it, and the Travel
 * checkbox belongs beside the swatch that says what travel looks like. Extracted from
 * `PreviewView.tsx` (which was already ~1400 lines) when it grew past the per-feature time table
 * it started as; that growth is also why it is no longer called the stats panel -- statistics are
 * now the last of its four sections rather than the whole of it.
 *
 * Counterpart: `lib/gcodeViewModes.ts` supplies the mode catalogue and the ramp, and
 * `lib/gcodePreview.ts` paints the geometry from those SAME functions, so a swatch here cannot
 * disagree with the bead it describes.
 */
import { Box, Button, Divider, IconButton, Option, Select, Sheet, Stack, Switch, Tooltip, Typography } from '@mui/joy'
import ExpandLessRoundedIcon from '@mui/icons-material/ExpandLessRounded'
import QueryStatsRoundedIcon from '@mui/icons-material/QueryStatsRounded'
import type { ThreeMfIndex } from '@printstream/shared'
import {
  GCODE_FEATURE_COLORS,
  gcodeMetricRange,
  type GcodeMarkerVisibility,
  type GcodeStats,
  type GcodeValueRanges
} from './lib/gcodePreview'
import { GCODE_FEATURE_NAMES } from './lib/gcodeFeatureRoles'
import {
  gcodeViewModeInfo,
  rangeLegendRows,
  GCODE_MARKER_COLORS,
  GCODE_MARKER_NAMES,
  GCODE_TRAVEL_COLORS,
  GCODE_VIEW_MODES,
  GCODE_WIPE_COLOR,
  type GcodeViewMode
} from './lib/gcodeViewModes'
import { formatSecondsDuration } from '../../lib/time'

/** A hex int as a CSS colour, for the swatches that must match the rendered geometry exactly. */
function swatchColor(hex: number): string {
  return `#${(hex >>> 0).toString(16).padStart(6, '0')}`
}

/** One legend row: a colour chip, a label, and an optional right-aligned value. */
function LegendRow({ color, label, value }: { color: string; label: string; value?: string }) {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
        <Box sx={{ width: 10, height: 10, borderRadius: '2px', flexShrink: 0, bgcolor: color }} />
        <Typography level="body-xs" textColor="neutral.300" noWrap>{label}</Typography>
      </Stack>
      {value ? (
        <Typography level="body-xs" textColor="neutral.100" sx={{ whiteSpace: 'nowrap' }}>{value}</Typography>
      ) : null}
    </Stack>
  )
}

/**
 * The marker checkboxes, in BambuStudio's legend order (`BaseRenderer.cpp:2019-2042`), each
 * carrying the colour the geometry is actually drawn in so the row doubles as its key.
 */
const MARKER_TOGGLES: ReadonlyArray<{ key: keyof GcodeMarkerVisibility; label: string; color: string }> = [
  { key: 'retract', label: GCODE_MARKER_NAMES[0]!, color: swatchColor(GCODE_MARKER_COLORS[0]!) },
  { key: 'unretract', label: GCODE_MARKER_NAMES[1]!, color: swatchColor(GCODE_MARKER_COLORS[1]!) },
  { key: 'wipe', label: 'Wipe', color: swatchColor(GCODE_WIPE_COLOR) },
  { key: 'seam', label: GCODE_MARKER_NAMES[2]!, color: swatchColor(GCODE_MARKER_COLORS[2]!) }
]

/** A "show this" row: the thing's own colour, its name, and the switch. */
function ShowRow({
  label,
  color,
  checked,
  onChange
}: { label: string; color: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
        <Box sx={{ width: 10, height: 10, borderRadius: '2px', flexShrink: 0, bgcolor: color }} />
        <Typography level="body-xs" textColor="neutral.300" noWrap>{label}</Typography>
      </Stack>
      <Switch
        size="sm"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        slotProps={{ input: { 'aria-label': `Show ${label.toLowerCase()}` } }}
      />
    </Stack>
  )
}

export interface GcodeToolpathPanelProps {
  stats: GcodeStats
  ranges: GcodeValueRanges
  plate: ThreeMfIndex['plates'][number] | null
  layerCount: number
  open: boolean
  onToggle: () => void
  viewMode: GcodeViewMode
  onViewModeChange: (mode: GcodeViewMode) => void
  showTravel: boolean
  onShowTravelChange: (show: boolean) => void
  markers: GcodeMarkerVisibility
  onMarkersChange: (markers: GcodeMarkerVisibility) => void
  /** Opens the all-plates statistics window. Omitted when the project has only one plate. */
  onShowAllPlates?: () => void
  /**
   * Extra space to leave below the panel, for whatever else is occupying the viewport's bottom.
   *
   * Today that is the toolpath-conflict banner, which is present only on a conflicting plate.
   */
  bottomReservePx?: number
}

export function GcodeToolpathPanel({
  stats,
  ranges,
  plate,
  layerCount,
  open,
  onToggle,
  viewMode,
  onViewModeChange,
  showTravel,
  onShowTravelChange,
  markers,
  onMarkersChange,
  onShowAllPlates,
  bottomReservePx = 0
}: GcodeToolpathPanelProps) {
  const authoritativeTotal = plate?.prediction ?? stats.headerTotalSeconds ?? stats.totalSeconds
  const scale = stats.totalSeconds > 0 && authoritativeTotal > 0 ? authoritativeTotal / stats.totalSeconds : 1
  const rows = stats.featureSeconds
    .map((seconds, role) => ({ role, seconds: seconds * scale }))
    .filter((row) => row.seconds >= 0.5)
    .sort((left, right) => right.seconds - left.seconds)
  const travelSeconds = stats.travelSeconds * scale
  const wipeSeconds = stats.wipeSeconds * scale
  const percentOf = (seconds: number) => authoritativeTotal > 0 ? `${Math.max(1, Math.round((seconds / authoritativeTotal) * 100))}%` : ''
  const usedFilaments = (plate?.filaments ?? []).filter((filament) => filament.usedGrams != null && filament.usedGrams > 0)

  const modeInfo = gcodeViewModeInfo(viewMode)
  // The Speed ramp depends on whether travel is on screen, because travel feedrates only join the
  // range while they are shown. Passing `showTravel` here is what keeps the legend's numbers equal
  // to the ones the geometry was painted with.
  const metricRange = modeInfo.metric ? gcodeMetricRange(ranges, modeInfo.metric, showTravel) : null
  const legendRows = metricRange ? rangeLegendRows(metricRange) : []

  if (!open) {
    return (
      <Tooltip title="Toolpath legend and statistics">
        <IconButton
          size="sm"
          variant="soft"
          onClick={onToggle}
          aria-label="Show the toolpath legend"
          sx={{ position: 'absolute', left: 12, top: 72, zIndex: 1, bgcolor: 'rgba(13, 19, 34, 0.72)', backdropFilter: 'blur(2px)' }}
        >
          <QueryStatsRoundedIcon />
        </IconButton>
      </Tooltip>
    )
  }

  return (
    <Sheet
      variant="soft"
      sx={{
        position: 'absolute',
        left: 12,
        // Below the Moves scrubber strip (top: 12 + its height), never over it.
        top: 72,
        zIndex: 1,
        px: 1.25,
        py: 1,
        borderRadius: 'md',
        bgcolor: 'rgba(13, 19, 34, 0.78)',
        backdropFilter: 'blur(2px)',
        width: 'min(248px, calc(100% - 110px))',
        // The panel grows downward from `top: 72`, and the conflict banner comes UP from the
        // bottom edge, so the two can meet. The banner tells the panel how much room it needs
        // rather than either guessing: both carry `zIndex: 1` and the banner renders later, so an
        // overlap is not a cosmetic near-miss, it silently takes the panel's clicks.
        maxHeight: `calc(100% - ${140 + bottomReservePx}px)`,
        overflow: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5
      }}
    >
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
        onClick={onToggle}
        sx={{ cursor: 'pointer', userSelect: 'none' }}
        aria-label="Collapse the toolpath legend"
      >
        <Typography level="title-sm" textColor="neutral.100">Toolpath</Typography>
        <Tooltip title="Collapse">
          <IconButton size="sm" variant="plain" aria-label="Hide the toolpath legend">
            <ExpandLessRoundedIcon />
          </IconButton>
        </Tooltip>
      </Stack>

      <Select
        size="sm"
        value={viewMode}
        // Joy fires onChange(null) spuriously in some flows; only a real mode is a user pick.
        onChange={(_event, value) => { if (value) onViewModeChange(value) }}
        slotProps={{ button: { 'aria-label': 'Colour toolpaths by' } }}
      >
        {GCODE_VIEW_MODES.map((entry) => (
          <Option key={entry.mode} value={entry.mode}>{entry.label}</Option>
        ))}
      </Select>

      {modeInfo.metric ? (
        <>
          <Typography level="body-xs" textColor="neutral.400">{modeInfo.legendTitle}</Typography>
          {legendRows.length > 0 ? legendRows.map((row) => (
            <LegendRow
              key={`${row.color}-${row.value}`}
              color={swatchColor(row.color)}
              label={row.value.toFixed(modeInfo.decimals)}
            />
          )) : (
            <Typography level="body-xs" textColor="neutral.400">Not recorded in this file</Typography>
          )}
        </>
      ) : (
        rows.length > 0 ? (
          <>
            {rows.map((row) => (
              <LegendRow
                key={row.role}
                color={swatchColor(GCODE_FEATURE_COLORS[row.role] ?? 0x888888)}
                label={GCODE_FEATURE_NAMES[row.role] ?? 'Other'}
                value={`${formatSecondsDuration(Math.max(1, Math.round(row.seconds)))} · ${percentOf(row.seconds)}`}
              />
            ))}
            {travelSeconds >= 0.5 && (
              <LegendRow
                color={swatchColor(GCODE_TRAVEL_COLORS[0]!)}
                label="Travel"
                value={`${formatSecondsDuration(Math.max(1, Math.round(travelSeconds)))} · ${percentOf(travelSeconds)}`}
              />
            )}
            {wipeSeconds >= 0.5 && (
              <LegendRow
                color={swatchColor(GCODE_WIPE_COLOR)}
                label="Wipe"
                value={`${formatSecondsDuration(Math.max(1, Math.round(wipeSeconds)))} · ${percentOf(wipeSeconds)}`}
              />
            )}
          </>
        ) : null
      )}

      <Divider sx={{ my: 0.25 }} />
      <Typography level="body-xs" textColor="neutral.400">Show</Typography>
      <ShowRow
        label="Travel"
        color={swatchColor(GCODE_TRAVEL_COLORS[0]!)}
        checked={showTravel}
        onChange={onShowTravelChange}
      />
      {MARKER_TOGGLES.map(({ key, label, color }) => (
        <ShowRow
          key={key}
          label={label}
          color={color}
          checked={markers[key] ?? false}
          onChange={(next) => onMarkersChange({ ...markers, [key]: next })}
        />
      ))}

      <Divider sx={{ my: 0.25 }} />
      <Stack direction="row" justifyContent="space-between" spacing={1}>
        <Typography level="body-xs" textColor="neutral.300">Total time</Typography>
        <Typography level="body-xs" fontWeight="lg" textColor="neutral.100">
          {formatSecondsDuration(Math.round(authoritativeTotal))}
        </Typography>
      </Stack>
      <Stack direction="row" justifyContent="space-between" spacing={1}>
        <Typography level="body-xs" textColor="neutral.300">Layers</Typography>
        <Typography level="body-xs" textColor="neutral.100">{layerCount} · {stats.maxZ.toFixed(1)} mm</Typography>
      </Stack>
      {(plate?.weight != null || stats.filamentMm > 0) && (
        <Stack direction="row" justifyContent="space-between" spacing={1}>
          <Typography level="body-xs" textColor="neutral.300">Filament</Typography>
          <Typography level="body-xs" textColor="neutral.100">
            {plate?.weight != null ? `${plate.weight.toFixed(1)} g` : ''}
            {plate?.weight != null && stats.filamentMm > 0 ? ' · ' : ''}
            {stats.filamentMm > 0 ? `${(stats.filamentMm / 1000).toFixed(2)} m` : ''}
          </Typography>
        </Stack>
      )}
      {usedFilaments.length > 1 && usedFilaments.map((filament) => (
        <Stack key={filament.id} direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
          <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
            <Box sx={{ width: 10, height: 10, borderRadius: '2px', flexShrink: 0, bgcolor: filament.color || 'neutral.softBg', border: '1px solid rgba(255,255,255,0.18)' }} />
            <Typography level="body-xs" textColor="neutral.300" noWrap>
              {filament.filamentName ?? filament.filamentType ?? `Filament ${filament.id}`}
            </Typography>
          </Stack>
          <Typography level="body-xs" textColor="neutral.100">{filament.usedGrams!.toFixed(1)} g</Typography>
        </Stack>
      ))}
      {onShowAllPlates && (
        <Button size="sm" variant="soft" onClick={onShowAllPlates} sx={{ mt: 0.5 }}>
          All plates…
        </Button>
      )}
    </Sheet>
  )
}
