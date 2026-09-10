/**
 * Fixed points marked ON a progress bar's track: today, the baked pauses of a running print.
 *
 * Rendered as CHILDREN of `ProgressBar`, which passes them through to Joy's `LinearProgress`
 * root. That root is `position: relative` and its fill is a `::before`, so an absolutely
 * positioned child paints over the fill without touching it, which matters because the fill is
 * mid-tween (`ProgressBar` transitions `inline-size`) and a marker must NOT move with it. The
 * marks are properties of the job, not of how far along it is.
 *
 * ## The 1px that keeps a mark honest
 *
 * `printerJobProgressStyles.ts` insets the fill by 1px on each side
 * (`left: 1px; inline-size: max(calc(percent * 1% - 2px), 0px)`), so at percent P over a
 * containing block of width W the fill's leading EDGE sits at `P%·W - 1px`, not at `P%·W`. Marks
 * are therefore placed at `calc(P% - 1px)` against that same containing block, which lands each
 * one exactly on the edge it describes at every percent.
 *
 * The two near-misses, both of which look right and are not. A plain `P%` is a constant 1px to
 * the right of the fill edge, which reads as the printer having passed a pause it has not
 * reached. An inset WRAPPER (marks at `P%` of a box 2px narrower) is worse, not better: it
 * resolves to `1px + P%·(W - 2px)`, i.e. `2px·(1 - P/100)` past the edge, so it is 2px out at the
 * start of a print and only correct at 100%.
 *
 * Counterpart: `PrinterJobProgressBlock`, which owns that inset and is the only caller.
 */
import { Box, Tooltip } from '@mui/joy'

/**
 * Amber, matching the stripe the 3MF editor draws on the model at each pause height
 * (`plugins/model-studio/editorGeometry.ts`, `vec3(1.0, 0.62, 0.11)`). One colour means one
 * thing across the app: a user sees the same amber on the model they authored the pause on and
 * on the bar of the print that will stop there.
 */
const PAUSE_MARKER_COLOR = 'rgb(255, 158, 28)'

export interface ProgressBarMarker {
  /** Stable identity for the list. */
  key: string
  /** Position on the SAME 0-100 scale the bar's `value` uses. */
  percent: number
  /** Hover/tap description, e.g. "Pause at layer 140, about 35 min away". */
  label: string
  color?: string
}

/**
 * Pointer target width. The visible line is 2px, which is not a hit area on any device, so the
 * grab region is widened invisibly around it rather than fattening the mark itself.
 */
const MARKER_HIT_WIDTH = 12

export function ProgressBarMarkers({ markers }: { markers: readonly ProgressBarMarker[] }) {
  if (markers.length === 0) return null

  return (
    <Box
      // Decorative, and deliberately so. Joy's bar root is `role="progressbar"`, whose children
      // ARIA defines as presentational, so an `aria-label` on anything in here is dropped from
      // the accessibility tree however it is written: leaving one would have looked like
      // accessibility work that does nothing. The pauses reach a screen reader as the text
      // readout beside the bar instead (`lib/printPauseMarkers.ts`), the same split the AMS
      // remaining bar uses.
      aria-hidden
      sx={{
        position: 'absolute',
        inset: 0,
        // The bar itself is not interactive, so only the marks take pointer events back.
        pointerEvents: 'none'
      }}
    >
      {markers.map((marker) => (
        <Tooltip key={marker.key} title={marker.label} size="sm" variant="soft" placement="top">
          <Box
            data-testid="progress-bar-marker"
            data-marker-label={marker.label}
            sx={{
              position: 'absolute',
              insetBlock: 0,
              // `- 1px` lands the mark on the fill's leading edge rather than 1px past it; see
              // the module header for why the obvious alternatives are both wrong.
              left: `calc(${marker.percent}% - 1px)`,
              width: MARKER_HIT_WIDTH,
              transform: 'translateX(-50%)',
              display: 'grid',
              placeItems: 'center',
              pointerEvents: 'auto'
            }}
          >
            <Box
              aria-hidden
              sx={{
                width: '2px',
                blockSize: '100%',
                borderRadius: '1px',
                backgroundColor: marker.color ?? PAUSE_MARKER_COLOR,
                // A mark has to read against everything the bar can be under it: the dark track,
                // the blue printing fill, and the AMBER paused fill, which is close enough to the
                // mark's own colour that a bare tick disappears into it exactly when the user is
                // standing at the printer wondering which pause this is. The dark halo is the
                // same trick the AMS remaining bar uses to sit on any filament swatch.
                boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.55)'
              }}
            />
          </Box>
        </Tooltip>
      ))}
    </Box>
  )
}
