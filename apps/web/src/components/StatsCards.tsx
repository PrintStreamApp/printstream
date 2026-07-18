import type { StatsActivityHistory } from '@printstream/shared'
import type { ReactNode } from 'react'
import { Box, Card, CardContent, Stack, Typography } from '@mui/joy'
import { createTheme, ThemeProvider as MaterialThemeProvider } from '@mui/material/styles'
import { LineChart } from '@mui/x-charts/LineChart'
import { PieChart } from '@mui/x-charts/PieChart'

type BaseStatCardProps = {
  icon: ReactNode
  label: string
}

type BreakdownItem = {
  label: string
  value: string
  amount: number
  color: string
  detail?: string
}

const EMPTY_CHART_COLOR = 'var(--joy-palette-neutral-softBg)'

const CHART_SIZE = 110
const ACTIVITY_CHART_HEIGHT = 92
const PRINTER_ACTIVITY_COLOR = 'var(--joy-palette-success-400)'
const TOTAL_PRINTER_ACTIVITY_COLOR = 'var(--joy-palette-neutral-500)'
const USED_CAPACITY_COLOR = 'var(--joy-palette-success-400)'
const TOTAL_CAPACITY_COLOR = 'var(--joy-palette-neutral-500)'
const chartTheme = createTheme({
  palette: {
    mode: 'dark'
  }
})

type TrendSeries = {
  id: string
  label: string
  color: string
  data: number[]
  valueFormatter: (value: number | null) => string
}

function formatActivityDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(`${date}T00:00:00.000Z`))
}

function renderStatCard(content: ReactNode) {
  return (
    <Card
      variant="outlined"
      sx={{
        height: '100%',
        textAlign: 'left',
        overflow: 'visible',
        position: 'relative',
        zIndex: 0,
        '&:hover, &:focus-within': {
          zIndex: 2
        }
      }}
    >
      {content}
    </Card>
  )
}

function resolveChartMax(series: readonly TrendSeries[]): number {
  return Math.max(1, ...series.flatMap((item) => item.data))
}

function renderTrendComparisonCard({
  icon,
  label,
  primaryValue,
  chartLabel,
  series,
  activityLast30Days
}: BaseStatCardProps & {
  primaryValue: string
  chartLabel: string
  series: readonly TrendSeries[]
  activityLast30Days: StatsActivityHistory
}) {
  const activityDates = activityLast30Days.map((point) => new Date(`${point.date}T00:00:00.000Z`))
  const chartMax = resolveChartMax(series)

  return renderStatCard(
    <CardContent sx={{ height: '100%' }}>
      <Stack spacing={1.5} sx={{ height: '100%' }}>
        <Typography level="title-sm" textColor="text.tertiary" startDecorator={icon}>{label}</Typography>
        <Typography level="h3">{primaryValue}</Typography>
        <Box sx={{ mt: 'auto' }}>
          <Typography level="body-xs" textColor="text.tertiary" sx={{ mb: 0.75 }}>
            {chartLabel}
          </Typography>
          <Stack direction="row" spacing={2} sx={{ mb: 0.75, flexWrap: 'wrap' }}>
            {series.map((item) => (
              <Stack key={item.id} direction="row" spacing={0.75} alignItems="center">
                <Box sx={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: item.color, flexShrink: 0 }} />
                <Typography level="body-xs" textColor="text.tertiary">{item.label}</Typography>
              </Stack>
            ))}
          </Stack>
          <MaterialThemeProvider theme={chartTheme}>
            <LineChart
              height={ACTIVITY_CHART_HEIGHT}
              hideLegend
              margin={{ top: 2, right: 8, bottom: 0, left: 8 }}
              xAxis={[{
                data: activityDates,
                scaleType: 'time',
                tickNumber: 5,
                valueFormatter: (value: Date) => formatActivityDate(value.toISOString().slice(0, 10))
              }]}
              yAxis={[{ width: 0, min: 0, max: chartMax }]}
              slotProps={{
                tooltip: {
                  trigger: 'axis',
                  sx: {
                    zIndex: (theme) => theme.zIndex.tooltip
                  }
                }
              }}
              series={series.map((item) => ({
                id: item.id,
                label: item.label,
                data: item.data,
                valueFormatter: item.valueFormatter,
                area: true,
                showMark: false,
                curve: 'monotoneX' as const,
                color: item.color
              }))}
              sx={{
                overflow: 'visible',
                '& .MuiChartsSurface-root': {
                  overflow: 'visible'
                },
                '& .MuiChartsGrid-line': {
                  stroke: 'rgba(255, 255, 255, 0.08)'
                },
                '& .MuiChartsAxis-line': {
                  stroke: 'rgba(255, 255, 255, 0.14)'
                },
                '& .MuiChartsAxis-tick': {
                  stroke: 'rgba(255, 255, 255, 0.14)'
                },
                '& .MuiChartsAxis-tickLabel': {
                  fill: 'var(--joy-palette-text-tertiary)',
                  fontFamily: 'var(--joy-fontFamily-body)',
                  fontSize: 'var(--joy-fontSize-xs)'
                },
                '& .MuiAreaElement-root': {
                  fillOpacity: 0.22
                },
                '& .MuiLineElement-root': {
                  strokeWidth: 2.25
                },
                '& .MuiMarkElement-root': {
                  display: 'none'
                },
                '& .MuiChartsAxis-left .MuiChartsAxis-line, & .MuiChartsAxis-left .MuiChartsAxis-tick, & .MuiChartsAxis-left .MuiChartsAxis-tickLabel': {
                  display: 'none'
                }
              }}
            />
          </MaterialThemeProvider>
        </Box>
      </Stack>
    </CardContent>
  )
}

function buildChartData(items: BreakdownItem[]) {
  const segments = items
    .map((item) => ({ ...item, amount: Math.max(0, item.amount) }))
    .filter((item) => item.amount > 0)

  if (segments.length === 0) {
    return [{ id: 'empty', value: 1, label: 'No tracked data', color: EMPTY_CHART_COLOR }]
  }

  return segments.map((item) => ({
    id: item.label,
    value: item.amount,
    label: item.label,
    color: item.color
  }))
}

export function SimpleStatCard({
  icon,
  label,
  value,
  description
}: BaseStatCardProps & {
  value: string
  description?: string
}) {
  return renderStatCard(
    <CardContent sx={{ height: '100%' }}>
      <Stack spacing={1} sx={{ height: '100%' }}>
        <Typography level="title-sm" textColor="text.tertiary" startDecorator={icon}>{label}</Typography>
        <Typography level="h3">{value}</Typography>
        {description ? <Typography level="body-sm" textColor="text.tertiary">{description}</Typography> : null}
      </Stack>
    </CardContent>
  )
}

export function BreakdownStatCard({
  icon,
  label,
  primaryValue,
  description,
  items,
  maxLegendItems
}: BaseStatCardProps & {
  primaryValue: string
  description?: string
  items: BreakdownItem[]
  /** Cap the named legend rows (the pie still shows every slice). Omit to list all. */
  maxLegendItems?: number
}) {
  const chartData = buildChartData(items)
  const chartColors = chartData.map((item) => item.color)
  const legendItems = maxLegendItems == null ? items : items.slice(0, maxLegendItems)
  const hiddenLegendCount = items.length - legendItems.length

  return renderStatCard(
    <CardContent sx={{ height: '100%' }}>
      <Stack spacing={1.5} sx={{ height: '100%' }}>
        <Typography level="title-sm" textColor="text.tertiary" startDecorator={icon}>{label}</Typography>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1.5}
          alignItems={{ xs: 'stretch', sm: 'stretch' }}
          sx={{ flex: 1, minHeight: 0 }}
        >
          <Stack spacing={1} sx={{ flex: 1, minWidth: 0, justifyContent: 'space-between' }}>
            <Stack spacing={1}>
              <Typography level="h3">{primaryValue}</Typography>
              {description ? <Typography level="body-sm" textColor="text.tertiary">{description}</Typography> : null}
            </Stack>
            <Stack spacing={0.875} sx={{ mt: 'auto' }}>
              {legendItems.map((item) => (
                <Stack key={item.label} spacing={0.25}>
                  <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="center">
                    <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
                      <Box
                        sx={{
                          width: 10,
                          height: 10,
                          borderRadius: '50%',
                          backgroundColor: item.color,
                          flexShrink: 0
                        }}
                      />
                      <Typography level="body-sm" sx={{ minWidth: 0 }}>{item.label}</Typography>
                    </Stack>
                    <Typography level="body-sm" fontWeight="lg" textAlign="right">{item.value}</Typography>
                  </Stack>
                  {item.detail ? (
                    <Typography level="body-xs" textColor="text.tertiary" sx={{ pl: 2.25 }}>
                      {item.detail}
                    </Typography>
                  ) : null}
                </Stack>
              ))}
              {hiddenLegendCount > 0 ? (
                <Typography level="body-xs" textColor="text.tertiary" sx={{ pl: 2.25 }}>
                  +{hiddenLegendCount} more
                </Typography>
              ) : null}
            </Stack>
          </Stack>
          <Box
            aria-hidden="true"
            sx={{
              flexShrink: 0,
              display: 'flex',
              alignItems: { xs: 'center', sm: 'flex-end' },
              justifyContent: { xs: 'center', sm: 'flex-end' },
              alignSelf: { xs: 'center', sm: 'flex-end' },
              mx: { xs: 'auto', sm: 0 },
              mt: { xs: 0.5, sm: 'auto' },
              minHeight: { xs: 'auto', sm: CHART_SIZE }
            }}
          >
            <MaterialThemeProvider theme={chartTheme}>
              <PieChart
                width={CHART_SIZE}
                height={CHART_SIZE}
                colors={chartColors}
                hideLegend
                slotProps={{
                  tooltip: {
                    sx: {
                      zIndex: (theme) => theme.zIndex.tooltip
                    }
                  }
                }}
                margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
                series={[
                  {
                    data: chartData,
                    innerRadius: 31,
                    outerRadius: 48,
                    startAngle: -90,
                    endAngle: 270,
                    cornerRadius: 5,
                    paddingAngle: chartData.length > 1 ? 2 : 0,
                    highlighted: { additionalRadius: 0 },
                    faded: { additionalRadius: 0 }
                  }
                ]}
                sx={{
                  '& .MuiChartsSurface-root': {
                    overflow: 'visible'
                  },
                  '& .MuiChartsWrapper-root': {
                    justifyItems: 'end',
                    alignItems: 'end'
                  },
                  '& .MuiPieArc-root': {
                    stroke: 'var(--joy-palette-background-surface)',
                    strokeWidth: 1.5
                  },
                  '& .MuiPieArcLabel-root': {
                    fill: 'var(--joy-palette-text-primary)',
                    fontFamily: 'var(--joy-fontFamily-body)',
                    fontSize: 'var(--joy-fontSize-xs)'
                  }
                }}
              />
            </MaterialThemeProvider>
          </Box>
        </Stack>
      </Stack>
    </CardContent>
  )
}

export function ActivityTrendStatCard({
  icon,
  label,
  activePrintersValue,
  activityLast30Days
}: BaseStatCardProps & {
  activePrintersValue: string
  activityLast30Days: StatsActivityHistory
}) {
  return renderTrendComparisonCard({
    icon,
    label,
    primaryValue: activePrintersValue,
    chartLabel: 'Daily printers used vs total',
    activityLast30Days,
    series: [
      {
        id: 'total-printers',
        label: 'Total printers',
        color: TOTAL_PRINTER_ACTIVITY_COLOR,
        data: activityLast30Days.map((point) => point.totalPrinterCount),
        valueFormatter: (value) => value == null ? '' : `${new Intl.NumberFormat().format(value)} printers`
      },
      {
        id: 'active-printers',
        label: 'Printers used',
        color: PRINTER_ACTIVITY_COLOR,
        data: activityLast30Days.map((point) => point.activePrinterCount),
        valueFormatter: (value) => value == null ? '' : `${new Intl.NumberFormat().format(value)} printers`
      }
    ]
  })
}

export function CapacityTrendStatCard({
  icon,
  label,
  capacityValue,
  activityLast30Days
}: BaseStatCardProps & {
  capacityValue: string
  activityLast30Days: StatsActivityHistory
}) {
  return renderTrendComparisonCard({
    icon,
    label,
    primaryValue: capacityValue,
    chartLabel: 'Daily print hours used vs capacity',
    activityLast30Days,
    series: [
      {
        id: 'total-capacity',
        label: 'Capacity',
        color: TOTAL_CAPACITY_COLOR,
        data: activityLast30Days.map((point) => point.capacityPrintHours),
        valueFormatter: (value) => value == null ? '' : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)} h`
      },
      {
        id: 'used-capacity',
        label: 'Print time used',
        color: USED_CAPACITY_COLOR,
        data: activityLast30Days.map((point) => point.usedPrintHours),
        valueFormatter: (value) => value == null ? '' : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)} h`
      }
    ]
  })
}