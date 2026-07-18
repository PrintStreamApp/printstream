/**
 * Shared chart colour constants for the stats cards and their breakdown consumers.
 * Own module (not `StatsCards.tsx`) so the card file exports only components
 * (react-refresh).
 */

/**
 * Distinct hues for categorical breakdowns with an open-ended number of slices
 * (filament types, brands, …). Assign by slice index; the ramp repeats past its
 * length, which is fine since only the leading slices are named in the legend.
 */
export const CATEGORICAL_STAT_COLORS = [
  'var(--joy-palette-primary-400)',
  'var(--joy-palette-success-400)',
  'var(--joy-palette-warning-400)',
  'var(--joy-palette-danger-400)',
  'var(--joy-palette-primary-200)',
  'var(--joy-palette-success-200)',
  'var(--joy-palette-warning-200)',
  'var(--joy-palette-neutral-400)'
]
