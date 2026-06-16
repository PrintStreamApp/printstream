/**
 * Shared plugin-related query invalidation.
 *
 * Plugin activation can change shell routes, permissions, and auth policy,
 * so callers must refresh all plugin and auth bootstrap queries together.
 */
import type { QueryClient } from '@tanstack/react-query'

export async function invalidatePluginRelatedQueries(queryClient: Pick<QueryClient, 'invalidateQueries'>): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['admin-plugins'] }),
    queryClient.invalidateQueries({ queryKey: ['plugin-catalog'] }),
    queryClient.invalidateQueries({ queryKey: ['auth-bootstrap'] }),
    queryClient.invalidateQueries({ queryKey: ['plugin-settings'] })
  ])
}