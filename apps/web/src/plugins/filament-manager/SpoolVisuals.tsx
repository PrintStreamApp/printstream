/**
 * Small presentational leaves shared by the spool list and grid: a colour
 * swatch (solid or multi-colour gradient) and a remaining-filament bar that
 * shows the level both graphically and numerically.
 */
import { Box, LinearProgress, Stack, Typography } from '@mui/joy'
import { LOW_REMAIN_PERCENT } from './constants'

export function SpoolColorSwatch({
  colorHex,
  colors,
  size = 24
}: {
  colorHex: string | null
  colors: string[]
  size?: number
}) {
  const palette = colors.length > 0 ? colors : colorHex ? [colorHex] : []
  const background = palette.length === 0
    ? 'var(--joy-palette-neutral-softBg)'
    : palette.length === 1
      ? palette[0]
      : `conic-gradient(${palette.map((c, i) => `${c} ${(i / palette.length) * 100}% ${((i + 1) / palette.length) * 100}%`).join(', ')})`
  return (
    <Box
      aria-hidden
      sx={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: '50%',
        background,
        border: '1px solid',
        borderColor: 'rgba(0,0,0,0.25)',
        boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.25)'
      }}
    />
  )
}

function remainingColor(remainPercent: number | null): 'success' | 'warning' | 'danger' {
  if (remainPercent == null) return 'success'
  if (remainPercent <= 0) return 'danger'
  if (remainPercent <= LOW_REMAIN_PERCENT) return 'warning'
  return 'success'
}

export function SpoolRemaining({
  remainingGrams,
  remainPercent,
  netWeightGrams,
  size = 'sm'
}: {
  remainingGrams: number
  remainPercent: number | null
  netWeightGrams: number
  size?: 'sm' | 'lg'
}) {
  const value = remainPercent ?? Math.max(0, Math.min(100, (remainingGrams / Math.max(1, netWeightGrams)) * 100))
  return (
    <Stack spacing={0.5} sx={{ minWidth: 0, width: '100%' }}>
      <LinearProgress
        determinate
        value={value}
        color={remainingColor(remainPercent)}
        thickness={size === 'lg' ? 8 : 6}
      />
      <Typography level="body-xs" textColor="text.tertiary">
        {Math.round(remainingGrams)} g
        {netWeightGrams ? ` / ${netWeightGrams} g` : ''}
        {remainPercent != null ? ` · ${remainPercent}%` : ''}
      </Typography>
    </Stack>
  )
}
