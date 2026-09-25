/** Shared date selector for workspace and single-printer statistics. */
import { useState } from 'react'
import { Button, Input, Option, Select, Stack, Typography } from '@mui/joy'
import { statsDateRangeQuerySchema } from '@printstream/shared'
import { recentStatsDateRange, type StatsDateRangeSelection } from '../lib/statsDateRange'

type Preset = '7' | '30' | '90' | '365' | 'all' | 'custom'

function presetForRange(value: StatsDateRangeSelection): Preset {
  if (!value) return 'all'
  for (const days of [7, 30, 90, 365] as const) {
    const recent = recentStatsDateRange(days)
    if (value.from === recent.from && value.to === recent.to) return String(days) as Preset
  }
  return 'custom'
}

export function StatsDateRangePicker({
  value,
  onChange
}: {
  value: StatsDateRangeSelection
  onChange: (range: StatsDateRangeSelection) => void
}) {
  const [preset, setPreset] = useState<Preset>(() => presetForRange(value))
  const [from, setFrom] = useState(value?.from ?? recentStatsDateRange(30).from)
  const [to, setTo] = useState(value?.to ?? recentStatsDateRange(30).to)
  const today = new Date().toISOString().slice(0, 10)
  const validCustomRange = statsDateRangeQuerySchema.safeParse({ from, to }).success && to <= today

  return (
    <Stack direction="row" spacing={0.75} useFlexGap alignItems="center" sx={{ flexWrap: 'wrap' }}>
      <Select<Preset>
        size="sm"
        aria-label="Stats date range"
        value={preset}
        onChange={(_, next) => {
          if (!next) return
          setPreset(next)
          if (next === 'all') {
            onChange(null)
          } else if (next !== 'custom') {
            const range = recentStatsDateRange(Number(next))
            setFrom(range.from)
            setTo(range.to)
            onChange(range)
          }
        }}
        sx={{ minWidth: 150 }}
      >
        <Option value="7">Last 7 days</Option>
        <Option value="30">Last 30 days</Option>
        <Option value="90">Last 90 days</Option>
        <Option value="365">Last 365 days</Option>
        <Option value="all">All time</Option>
        <Option value="custom">Custom range</Option>
      </Select>
      {preset === 'custom' ? (
        <>
          <Input size="sm" type="date" aria-label="Stats start date" value={from} slotProps={{ input: { max: today } }} onChange={(event) => setFrom(event.target.value)} />
          <Typography level="body-sm" textColor="text.tertiary">to</Typography>
          <Input size="sm" type="date" aria-label="Stats end date" value={to} slotProps={{ input: { min: from, max: today } }} onChange={(event) => setTo(event.target.value)} />
          <Button size="sm" variant="soft" disabled={!validCustomRange} onClick={() => onChange({ from, to })}>Apply</Button>
          {!validCustomRange ? (
            <Typography level="body-xs" color="warning">Choose valid dates within 366 days, ending today or earlier.</Typography>
          ) : null}
        </>
      ) : null}
    </Stack>
  )
}
