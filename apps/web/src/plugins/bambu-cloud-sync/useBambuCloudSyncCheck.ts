/** Shared sync preview for the compact badge and preset manager, isolated by workspace. */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { bambuCloudSyncCheckResponseSchema } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { readCurrentWorkspaceScopeKey } from '../../lib/workspaceScope'

/** Check on opening a preset surface, sharing a five-minute cache between both surfaces. */
export function useBambuCloudSyncCheck(enabled = true) {
  const queryClient = useQueryClient()
  const workspaceScope = readCurrentWorkspaceScopeKey()
  return useQuery({
    queryKey: ['bambu-cloud-sync', 'check', workspaceScope],
    queryFn: async ({ signal }) => {
      const response = await apiFetch<unknown>('/api/plugins/bambu-cloud-sync/check', { method: 'POST', signal })
      const check = bambuCloudSyncCheckResponseSchema.parse(response)
      // Checks persist newly discovered deletion decisions. Refresh their controls
      // after that write, including when the manager fetched status before checking.
      await queryClient.invalidateQueries({ queryKey: ['bambu-cloud-sync', 'status', workspaceScope] })
      return check
    },
    enabled,
    staleTime: 5 * 60_000,
    retry: false
  })
}
