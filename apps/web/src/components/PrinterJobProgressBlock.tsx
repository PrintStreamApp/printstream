import { LinearProgress, Stack, type ColorPaletteProp } from '@mui/joy'
import type { ReactNode } from 'react'
import { printerJobProgressSx } from './printerJobProgressStyles'

export function PrinterJobProgressBlock({
  header,
  headerAside,
  headerAction,
  showProgress = true,
  determinate,
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
  determinate: boolean
  value: number
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
        <LinearProgress
          determinate={determinate}
          value={value}
          color={color}
          sx={{
            ...printerJobProgressSx,
            backgroundColor: trackColor,
            '&::before': determinate
              ? {
                  ...printerJobProgressSx['&::before'],
                  backgroundColor: fillColor,
                }
              : fillColor
                ? {
                    ...printerJobProgressSx['&::before'],
                    backgroundColor: fillColor
                  }
                : undefined
          }}
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