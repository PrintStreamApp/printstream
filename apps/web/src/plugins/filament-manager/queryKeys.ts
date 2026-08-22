/**
 * TanStack Query keys for the filament-manager plugin.
 *
 * Their own module so the data layer (`api.ts`) and the live-sync subscription
 * (`useFilamentSync.ts`) can each name a key without importing the other: the
 * queries mount the sync, and the sync invalidates the queries, which as one
 * module would be a cycle.
 */
export const SPOOLS_QUERY_KEY = ['filament-manager', 'spools'] as const
export const FILAMENT_STATS_QUERY_KEY = ['filament-manager', 'stats'] as const
export const FILAMENT_SETTINGS_QUERY_KEY = ['plugin-settings', 'filament-manager'] as const
export const spoolUsageQueryKey = (id: string) => ['filament-manager', 'usage', id] as const
