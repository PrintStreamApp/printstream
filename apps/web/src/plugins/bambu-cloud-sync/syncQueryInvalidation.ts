/** Keeps account status, sync previews, and preset lists consistent after plugin mutations. */
import type { QueryClient } from '@tanstack/react-query'

/** Refresh both mounted sync surfaces; inactive previews stay stale until reopened. */
export async function invalidateBambuCloudSyncQueries(queryClient: Pick<QueryClient, 'invalidateQueries'>): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['slicing-profiles'] }),
    queryClient.invalidateQueries({ queryKey: ['bambu-cloud-sync', 'status'] }),
    queryClient.invalidateQueries({ queryKey: ['bambu-cloud-sync', 'check'] })
  ])
}
