/**
 * The "Filament types" + "Filament brands" donut stat cards, rendered from a
 * FilamentUsageStats. Shared by the per-workspace stats page (filament-manager
 * plugin) and the platform overview so both render identically. Each donut shows
 * every slice; the legend names only the top few. Renders nothing when there is
 * no tracked filament usage.
 */
import CategoryRoundedIcon from '@mui/icons-material/CategoryRounded'
import StorefrontRoundedIcon from '@mui/icons-material/StorefrontRounded'
import type { FilamentUsageSlice, FilamentUsageStats } from '@printstream/shared'
import { BreakdownStatCard, CATEGORICAL_STAT_COLORS } from './StatsCards'

/** Named legend rows per card; remaining slices still render in the donut. */
const LEGEND_LIMIT = 3

function formatKilograms(grams: number): string {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(grams / 1000)} kg`
}

/** Map sorted usage slices to the BreakdownStatCard item shape, colouring by rank. */
function toBreakdownItems(slices: FilamentUsageSlice[]) {
  return slices.map((slice, index) => ({
    label: slice.label,
    value: formatKilograms(slice.gramsUsed),
    amount: slice.gramsUsed,
    color: CATEGORICAL_STAT_COLORS[index % CATEGORICAL_STAT_COLORS.length] ?? 'var(--joy-palette-neutral-400)'
  }))
}

export function FilamentBreakdownCards({ stats }: { stats: FilamentUsageStats }) {
  if (stats.totalGramsUsed <= 0) return null
  return (
    <>
      <BreakdownStatCard
        icon={<CategoryRoundedIcon />}
        label="Filament types"
        primaryValue={formatKilograms(stats.totalGramsUsed)}
        description={`Used across ${stats.byType.length} ${stats.byType.length === 1 ? 'type' : 'types'}.`}
        items={toBreakdownItems(stats.byType)}
        maxLegendItems={LEGEND_LIMIT}
      />
      <BreakdownStatCard
        icon={<StorefrontRoundedIcon />}
        label="Filament brands"
        primaryValue={formatKilograms(stats.totalGramsUsed)}
        description={`Used across ${stats.byBrand.length} ${stats.byBrand.length === 1 ? 'brand' : 'brands'}.`}
        items={toBreakdownItems(stats.byBrand)}
        maxLegendItems={LEGEND_LIMIT}
      />
    </>
  )
}
