import { Stack, type ColorPaletteProp } from '@mui/joy'
import type { ReactNode } from 'react'
import { ProgressBar } from './ProgressBar'
import { printerJobProgressSx } from './printerJobProgressStyles'

export function PrinterJobProgressBlock({
  header,
  headerAside,
  headerAction,
  showProgress = true,
  value,
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
        />
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