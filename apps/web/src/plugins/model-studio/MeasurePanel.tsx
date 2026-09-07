/**
 * Readout for the editor's measure tool: what the two picked features are, and what they measure.
 *
 * Presentational only -- the picks live in EditorView, and WHICH rows appear for a given pair is
 * `measurementRows`, so the rule lives beside the measurement rather than in the layout. Mirrors
 * BambuStudio's own panel (`GLGizmoMeasure.cpp:2155-2406`).
 */
import { Button, IconButton, Sheet, Stack, Tooltip, Typography } from '@mui/joy'
import { TOOL_PANEL_ANCHOR } from './editorPanels'
import { TOOL_PANEL_Z_INDEX } from './editorLayers'
import { MEASURE_POINT_COLORS } from './editorGeometry'
import { measureFeatureLabel } from './lib/measureFeatures'
import { measurementRows, type MeasurementResult } from './lib/measureBetween'
import type { MeasurePick } from './useEditorScene'

export interface MeasurePanelProps {
  /** The features picked so far, in the order they were picked. At most two. */
  picks: MeasurePick[]
  /** What those two features measure, or null until both are picked. */
  result: MeasurementResult | null
  onClear: () => void
  /** Drop one slot. Clearing the FIRST promotes the second into it, as the click path does. */
  onResetSlot: (slot: number) => void
  onDone: () => void
}

/**
 * Studio shows a circle's DIAMETER and an edge's LENGTH beside the name (`GLGizmoMeasure.cpp:2166`).
 *
 * Read off the SOURCE, so picking a hole's centre keeps the diameter of the hole it came from. Read
 * off the feature it would vanish at exactly the moment the user has said which hole they mean.
 */
function featureDetail(pick: MeasurePick): string | null {
  const feature = pick.source
  if (feature.kind === 'circle') return `Diameter ${(feature.radius * 2).toFixed(2)} mm`
  if (feature.kind === 'edge') return `Length ${feature.start.distanceTo(feature.end).toFixed(2)} mm`
  return null
}

/**
 * One measured value, with a copy button.
 *
 * The copied text omits the UNIT: it is nearly always on its way into a CAD field or a calculator,
 * where a pasted "mm" has to be deleted again every time.
 */
function Row({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
      <Typography level="body-xs" textColor="text.tertiary">{label}</Typography>
      <Stack direction="row" alignItems="center" spacing={0.5}>
        <Typography level="body-xs">{`${value}${unit}`}</Typography>
        <Tooltip title="Copy" size="sm">
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            sx={{ '--IconButton-size': '20px', minWidth: 20 }}
            onClick={() => { void navigator.clipboard?.writeText(value) }}
          >
            <Typography level="body-xs" textColor="text.tertiary">⧉</Typography>
          </IconButton>
        </Tooltip>
      </Stack>
    </Stack>
  )
}

export function MeasurePanel({ picks, result, onClear, onResetSlot, onDone }: MeasurePanelProps) {
  const [first, second] = picks
  const rows = result && first && second ? measurementRows(first.feature, second.feature, result) : []

  return (
    <Sheet
      variant="soft"
      sx={{
        position: 'absolute', ...TOOL_PANEL_ANCHOR, zIndex: TOOL_PANEL_Z_INDEX,
        p: 1.25, borderRadius: 'sm', boxShadow: 'sm',
        width: 'min(260px, calc(100% - 16px))',
        display: 'flex', flexDirection: 'column', gap: 0.75
      }}
    >
      <Typography level="title-sm">Measure</Typography>

      <Stack spacing={0.5}>
        {[0, 1].map((slot) => {
          const pick = picks[slot]
          const detail = pick ? featureDetail(pick) : null
          return (
            <Stack key={slot} direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
              <Typography
                level="body-xs"
                // The slot colours match the highlights in the viewport, which is the only thing
                // saying which of the two selections a given ring or edge on screen belongs to.
                sx={{ color: `#${MEASURE_POINT_COLORS[slot]!.toString(16).padStart(6, '0')}` }}
              >
                {slot === 0 ? 'First' : 'Second'}
              </Typography>
              <Stack direction="row" alignItems="center" spacing={0.5}>
                <Typography level="body-xs" textAlign="right">
                  {pick ? measureFeatureLabel(pick.feature, pick.source) : 'None'}
                  {detail ? <Typography level="body-xs" textColor="text.tertiary">{` (${detail})`}</Typography> : null}
                </Typography>
                <Tooltip title="Reset" size="sm">
                  <span>
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="neutral"
                      disabled={!pick}
                      sx={{ '--IconButton-size': '20px', minWidth: 20 }}
                      onClick={() => onResetSlot(slot)}
                    >
                      <Typography level="body-xs" textColor="text.tertiary">×</Typography>
                    </IconButton>
                  </span>
                </Tooltip>
              </Stack>
            </Stack>
          )
        })}
      </Stack>

      {rows.length > 0 ? (
        <Stack spacing={0.25}>
          {rows.map((row) => (
            <Row key={row.label} label={row.label} value={row.value} unit={row.unit} />
          ))}
        </Stack>
      ) : (
        <Typography level="body-xs" textColor="text.tertiary">
          {picks.length === 0
            ? 'Click an edge, corner or face to measure from. On a hole, click the ring to measure from its edge or the dot to measure from its centre. Hold Shift for an exact point. Drag to orbit.'
            : picks.length < 2
              ? 'Click a second feature to measure.'
              // Two picks and no rows is a pair with no answer (two planes meeting on a shared seam,
              // say). Repeating the "click a second feature" prompt there reads as the click having
              // failed, and the user re-clicks something that was already selected.
              : 'These two features have nothing to measure between them. Pick a different pair.'}
        </Typography>
      )}

      <Stack direction="row" spacing={0.75} justifyContent="flex-end">
        <Button size="sm" variant="plain" color="neutral" disabled={picks.length === 0} onClick={onClear}>
          Clear
        </Button>
        <Button size="sm" variant="soft" color="neutral" onClick={onDone}>
          Done
        </Button>
      </Stack>
    </Sheet>
  )
}
