/**
 * Filament-usage stat cards contributed to the core stats page via the
 * `stats.cards` plugin slot. Fetches the per-workspace usage and renders the
 * shared `FilamentBreakdownCards`. Renders nothing when the viewer lacks
 * `LIBRARY_VIEW` or the workspace has no tracked filament usage yet, so the slot
 * stays graceful on an empty stats page.
 */
import { LIBRARY_VIEW_PERMISSION } from '@printstream/shared'
import { FilamentBreakdownCards } from '../../components/FilamentBreakdownCards'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { useFilamentStatsQuery } from './api'

export function FilamentStatsCards() {
  const authBootstrapQuery = useAuthBootstrapQuery()
  const authEnabled = authBootstrapQuery.data?.authEnabled ?? false
  const permissions = authBootstrapQuery.data?.permissions ?? []
  const canView = authBootstrapQuery.data ? (!authEnabled || permissions.includes(LIBRARY_VIEW_PERMISSION)) : false

  const statsQuery = useFilamentStatsQuery(canView)
  const stats = statsQuery.data

  if (!canView || !stats) return null

  return <FilamentBreakdownCards stats={stats} />
}
