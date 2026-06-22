/**
 * Floating readout panel for the editor's two-point measure tool: the distance and per-axis deltas
 * between the two picked points, or the next-click hint. Presentational only — the picked points
 * live in EditorView.
 */
import { Button, Sheet, Stack, Typography } from '@mui/joy'
import { TOOL_PANEL_TOP } from './editorPanels'

export interface MeasurePanelProps {
  /** Distance + axis deltas between the two picked points, or null until both are placed. */
  measureDelta: { dx: number; dy: number; dz: number; distance: number } | null
  /** Number of points picked so far (drives the hint + Clear's disabled state). */
  pointCount: number
  onClear: () => void
  onDone: () => void
}

export function MeasurePanel({ measureDelta, pointCount, onClear, onDone }: MeasurePanelProps) {
  return (
    <Sheet
      variant="soft"
      sx={{
        position: 'absolute', top: TOOL_PANEL_TOP, left: 8, zIndex: (theme) => theme.zIndex.tooltip,
        p: 1.25, borderRadius: 'sm', boxShadow: 'sm',
        width: 'min(240px, calc(100% - 16px))',
        display: 'flex', flexDirection: 'column', gap: 0.75
      }}
    >
      <Typography level="title-sm">Measure</Typography>
      {measureDelta ? (
        <Stack spacing={0.25}>
          <Stack direction="row" justifyContent="space-between">
            <Typography level="body-sm" textColor="text.tertiary">Distance</Typography>
            <Typography level="body-sm" fontWeight="lg">{measureDelta.distance.toFixed(2)} mm</Typography>
          </Stack>
          {([['X', measureDelta.dx], ['Y', measureDelta.dy], ['Z', measureDelta.dz]] as const).map(([axis, value]) => (
            <Stack key={axis} direction="row" justifyContent="space-between">
              <Typography level="body-xs" textColor="text.tertiary">Δ{axis}</Typography>
              <Typography level="body-xs">{Math.abs(value).toFixed(2)} mm</Typography>
            </Stack>
          ))}
        </Stack>
      ) : (
        <Typography level="body-xs" textColor="text.tertiary">
          {pointCount === 0
            ? 'Click two points on models or the bed. Clicks snap to nearby corners; drag to orbit.'
            : 'Click a second point to measure.'}
        </Typography>
      )}
      <Stack direction="row" spacing={0.75} justifyContent="flex-end">
        <Button size="sm" variant="plain" color="neutral" disabled={pointCount === 0} onClick={onClear}>
          Clear
        </Button>
        <Button size="sm" variant="soft" color="neutral" onClick={onDone}>
          Done
        </Button>
      </Stack>
    </Sheet>
  )
}
