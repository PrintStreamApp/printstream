/**
 * Web data layer for the filament-manager plugin: query keys, TanStack hooks,
 * and the typed `apiFetch` wrappers for the spool endpoints. Mutations invalidate
 * the spool list locally for instant feedback; the WS `plugin.event` sync
 * (`useFilamentSync`) keeps other open clients in step.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  type FilamentSpool,
  type FilamentSpoolList,
  type FilamentUsageList,
  type SpoolCreateInput,
  type SpoolUpdateInput,
  type SpoolAdjustInput,
  type SpoolAssignInput
} from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'

export const SPOOLS_QUERY_KEY = ['filament-manager', 'spools'] as const
export const FILAMENT_SETTINGS_QUERY_KEY = ['plugin-settings', 'filament-manager'] as const
export const spoolUsageQueryKey = (id: string) => ['filament-manager', 'usage', id] as const

const BASE = '/api/plugins/filament-manager'

export function useSpoolsQuery() {
  return useQuery<FilamentSpool[]>({
    queryKey: SPOOLS_QUERY_KEY,
    queryFn: async ({ signal }) => {
      const data = await apiFetch<FilamentSpoolList>(`${BASE}/spools?includeArchived=true`, { signal })
      return data.spools
    },
    staleTime: 30_000
  })
}

export function useSpoolUsageQuery(id: string | null) {
  return useQuery<FilamentUsageList>({
    queryKey: spoolUsageQueryKey(id ?? 'none'),
    queryFn: ({ signal }) => apiFetch<FilamentUsageList>(`${BASE}/spools/${id}/usage`, { signal }),
    enabled: id != null
  })
}

export function useSpoolMutations() {
  const queryClient = useQueryClient()
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: SPOOLS_QUERY_KEY })
  }

  const create = useMutation({
    mutationFn: (input: SpoolCreateInput) => apiFetch<FilamentSpool>(`${BASE}/spools`, { method: 'POST', body: input }),
    onSuccess: invalidate
  })
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: SpoolUpdateInput }) =>
      apiFetch<FilamentSpool>(`${BASE}/spools/${id}`, { method: 'PATCH', body: input }),
    onSuccess: invalidate
  })
  const adjust = useMutation({
    mutationFn: ({ id, input }: { id: string; input: SpoolAdjustInput }) =>
      apiFetch<FilamentSpool>(`${BASE}/spools/${id}/adjust`, { method: 'POST', body: input }),
    onSuccess: invalidate
  })
  const recycle = useMutation({
    mutationFn: (id: string) => apiFetch(`${BASE}/spools/${id}/recycle`, { method: 'POST' }),
    onSuccess: invalidate
  })
  const unassign = useMutation({
    mutationFn: (id: string) => apiFetch<FilamentSpool>(`${BASE}/spools/${id}/unassign`, { method: 'POST' }),
    onSuccess: invalidate
  })
  const assign = useMutation({
    mutationFn: ({ id, input }: { id: string; input: SpoolAssignInput }) =>
      apiFetch<FilamentSpool>(`${BASE}/spools/${id}/assign`, { method: 'POST', body: input }),
    onSuccess: invalidate
  })

  return { create, update, adjust, recycle, unassign, assign }
}
