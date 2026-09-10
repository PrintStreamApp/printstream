import { Stack, type ColorPaletteProp } from '@mui/joy'
import type { ReactNode } from 'react'
import { ProgressBar } from './ProgressBar'
import { ProgressBarMarkers, type ProgressBarMarker } from './ProgressBarMarkers'
import { printerJobProgressSx } from './printerJobProgressStyles'

export function PrinterJobProgressBlock({
  header,
  headerAside,
  headerAction,
  showProgress = true,
  value,
  markers,
  color,
  fillColor,
  trackColor,
  footer,
  afterProgress
}: {
  header: ReactNode
  headerAside?: ReactNode
  headerAction?: ReactNode
  showProgress?: boolean
  /** Percentage 0-100, or `null` while the job is running with no reported extent. */
  value: number | null
  /**
   * Fixed points to mark on the track (baked pauses of a running print).
   *
   * Opt-in per call site, never derived here: this block is shared by seven states and only two
   * of them are a print in progress. A dispatch upload, a slice, a queued job and a finished
   * history row all render the same bar, where a pause mark would be meaningless.
   *
   * Ignored while indeterminate, because a mark is a position on a scale the bar is not
   * currently showing.
   */
  markers?: readonly ProgressBarMarker[]
  color: ColorPaletteProp
  fillColor?: string
  trackColor?: string
  footer?: ReactNode
  afterProgress?: ReactNode
}) {
  const lowerContent = afterProgress || footer

  return (
    <Stack
      sx={{
        minWidth: 0,
        flex: 1,
        alignSelf: 'stretch',
        display: 'grid',
        gridTemplateRows: lowerContent ? 'minmax(0, 1fr) auto minmax(0, 1fr)' : 'minmax(0, 1fr) auto',
        rowGap: { xs: 0.375, sm: 0.5 }
      }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={0.75} sx={{ minWidth: 0, alignSelf: 'center' }}>
        {header}
        {headerAside || headerAction ? (
          <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flexShrink: 0 }}>
            {headerAside}
            {headerAction}
          </Stack>
        ) : null}
      </Stack>
      {showProgress && (
        <ProgressBar
          value={value}
          color={color}
          sx={printerJobProgressSx({ value, fillColor, trackColor })}
        >
          {value != null && markers && markers.length > 0
            ? <ProgressBarMarkers markers={markers} />
            : null}
        </ProgressBar>
      )}
      {lowerContent && (
        <Stack spacing={{ xs: 0.375, sm: 0.5 }} sx={{ minWidth: 0, alignSelf: 'center' }}>
          {afterProgress}
          {footer}
        </Stack>
      )}
    </Stack>
  )
}