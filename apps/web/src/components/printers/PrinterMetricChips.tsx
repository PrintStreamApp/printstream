/**
 * Compact metric chips used in the printer card status strip.
 *
 * `MetricChip` is the shared soft chip primitive (icon + value, optional
 * tooltip, optionally clickable). `TempReadout` / `DualTempReadout` format
 * single- and dual-nozzle temperature readouts on top of it, and
 * `HeaterThermometerIcon` is the small inline thermometer glyph. All are
 * pure presentational components driven entirely by props.
 */
import { Box, Chip, Stack, Tooltip, Typography } from '@mui/joy'

export function TempReadout({
  icon,
  ariaLabel,
  current,
  target,
  tooltipTarget,
  onClick
}: {
  icon: React.ReactNode
  ariaLabel: string
  current: number | null
  target: number | null
  tooltipTarget?: number | null
  onClick?: () => void
}) {
  if (current == null) return null
  const value = `${Math.round(current)}°${target != null && target > 0 ? ` / ${Math.round(target)}°` : ''}`
  const fullTarget = tooltipTarget ?? target
  const tooltipValue = `${Math.round(current)}°${fullTarget != null && fullTarget > 0 ? ` / ${Math.round(fullTarget)}°` : ''}`
  return <MetricChip icon={icon} ariaLabel={ariaLabel} value={value} tooltipTitle={`${ariaLabel}: ${tooltipValue}`} onClick={onClick} />
}

export function DualTempReadout({
  icon,
  ariaLabel,
  values,
  showTargets,
  onClick
}: {
  icon: React.ReactNode
  ariaLabel: string
  values: Array<{ extruderId: number; currentTemp: number | null; targetTemp: number | null }>
  showTargets: boolean
  onClick?: () => void
}) {
  const parts = values
    .filter((entry) => entry.currentTemp != null)
    .map((entry) => {
      const currentValue = `${Math.round(entry.currentTemp!)}°`
      const targetValue = showTargets && entry.targetTemp != null && entry.targetTemp > 0
        ? ` / ${Math.round(entry.targetTemp)}°`
        : ''
      return `${currentValue}${targetValue}`
    })
  const tooltipParts = values
    .filter((entry) => entry.currentTemp != null)
    .map((entry) => {
      const currentValue = `${Math.round(entry.currentTemp!)}°`
      const targetValue = entry.targetTemp != null && entry.targetTemp > 0
        ? ` / ${Math.round(entry.targetTemp)}°`
        : ''
      return `${currentValue}${targetValue}`
    })

  if (parts.length === 0) return null

  return (
    <MetricChip
      icon={icon}
      ariaLabel={`${ariaLabel}: ${parts.join(', ')}`}
      tooltipTitle={`${ariaLabel}: ${tooltipParts.join(', ')}`}
      onClick={onClick}
      value={
        <Stack direction="row" spacing={0.5} alignItems="center">
          {parts.map((part, index) => (
            <Box key={`${part}-${index}`} component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
              {index > 0 ? (
                <Box
                  component="span"
                  aria-hidden
                  sx={{ color: 'text.tertiary', fontWeight: 'md', lineHeight: 1 }}
                >
                  |
                </Box>
              ) : null}
              <Typography component="span" level="body-xs" textColor="text.primary" sx={{ fontWeight: 'lg' }}>
                {part}
              </Typography>
            </Box>
          ))}
        </Stack>
      }
    />
  )
}

export function MetricChip({
  icon,
  ariaLabel,
  value,
  tooltipTitle,
  onClick
}: {
  icon: React.ReactNode
  ariaLabel: string
  value: React.ReactNode
  tooltipTitle?: React.ReactNode
  onClick?: () => void
}) {
  const resolvedTooltipTitle = tooltipTitle ?? (typeof value === 'string' ? `${ariaLabel}: ${value}` : ariaLabel)
  const chip = (
    <Chip
      size="sm"
      variant="soft"
      color="neutral"
      aria-label={ariaLabel}
      sx={{
        minHeight: { xs: 22, sm: 24 },
        px: { xs: 0.625, sm: 0.75 },
        borderRadius: 'sm',
        border: '1px solid rgba(196, 208, 221, 0.12)',
        backgroundColor: 'rgba(36, 48, 67, 0.58)',
        '& .MuiChip-label': {
          display: 'flex',
          alignItems: 'center',
          gap: 0.625,
          minWidth: 0
        }
      }}
    >
      <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
        <Box
          component="span"
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'text.tertiary',
            fontSize: '0.85rem',
            lineHeight: 1,
            flexShrink: 0
          }}
        >
          {icon}
        </Box>
      </Box>
      {typeof value === 'string' ? (
        <Typography component="span" level="body-xs" textColor="text.primary" sx={{ fontWeight: 'lg', lineHeight: 1.1 }}>
          {value}
        </Typography>
      ) : (
        value
      )}
    </Chip>
  )

  if (!onClick) {
    return (
      <Tooltip title={resolvedTooltipTitle} variant="soft" size="sm">
        {chip}
      </Tooltip>
    )
  }

  return (
    <Tooltip title={resolvedTooltipTitle} variant="soft" size="sm">
      <Box
        component="button"
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        sx={{
          p: 0,
          m: 0,
          border: 'none',
          background: 'none',
          display: 'inline-flex',
          cursor: 'pointer',
          borderRadius: 'sm',
          '&:focus-visible': {
            outline: '2px solid var(--joy-palette-primary-500)',
            outlineOffset: 2
          }
        }}
      >
        {chip}
      </Box>
    </Tooltip>
  )
}

export function HeaterThermometerIcon({ color }: { color: 'warning' | 'primary' | 'success' }) {
  const fill =
    color === 'warning'
      ? 'var(--joy-palette-warning-300)'
      : color === 'primary'
        ? 'var(--joy-palette-primary-300)'
        : 'var(--joy-palette-success-300)'

  return (
    <Box
      component="svg"
      viewBox="0 0 12 20"
      aria-hidden
      sx={{ width: '0.75rem', height: '1rem', display: 'block' }}
    >
      <Box component="rect" x="4.5" y="3" width="3" height="9.5" rx="0.5" sx={{ fill }} />
      <Box component="circle" cx="6" cy="15" r="2" sx={{ fill }} />
      <Box
        component="path"
        d="M6 0.5C4.6 0.5 3.5 1.6 3.5 3V12.1C2.6 12.8 2 13.9 2 15C2 17.2 3.8 19 6 19C8.2 19 10 17.2 10 15C10 13.9 9.4 12.8 8.5 12.1V3C8.5 1.6 7.4 0.5 6 0.5Z"
        sx={{ fill: 'none', stroke: fill, strokeWidth: 1 }}
      />
    </Box>
  )
}
