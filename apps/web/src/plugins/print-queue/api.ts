/**
 * Web data layer for the print-queue plugin: query keys, the items/settings queries,
 * and typed `apiFetch` mutation hooks. Mutations invalidate the queue locally for
 * instant feedback; the WS `print-queue` resource broadcast keeps other open clients
 * in step (see `usePrinterWebSocket`).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  type QueueDispatchInput,
  type QueueDryRunResult,
  type QueueItem,
  type QueueItemCreateInput,
  type QueueItemUpdateInput,
  type QueueList,
  type QueueSettings,
  type PrintDispatchJob
} from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'

const BASE = '/api/plugins/print-queue'

export const QUEUE_ITEMS_QUERY_KEY = ['print-queue', 'items'] as const
export const QUEUE_SETTINGS_QUERY_KEY = ['plugin-settings', 'print-queue'] as const

export function useQueueItemsQuery(enabled: boolean) {
  return useQuery<QueueList>({
    queryKey: QUEUE_ITEMS_QUERY_KEY,
    queryFn: ({ signal }) => apiFetch<QueueList>(`${BASE}/items`, { signal }),
    enabled
  })
}

export function useQueueSettingsQuery(enabled: boolean) {
  return useQuery<{ settings: QueueSettings }>({
    queryKey: QUEUE_SETTINGS_QUERY_KEY,
    queryFn: ({ signal }) => apiFetch<{ settings: QueueSettings }>(`${BASE}/settings`, { signal }),
    enabled,
    staleTime: 30_000
  })
}

function useInvalidateQueue() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: ['print-queue'] })
}

export function useAddQueueItem() {
  const invalidate = useInvalidateQueue()
  return useMutation({
    mutationFn: (input: QueueItemCreateInput) => apiFetch<{ item: QueueItem }>(`${BASE}/items`, { method: 'POST', body: input }),
    onSuccess: () => invalidate()
  })
}

export function useUpdateQueueItem() {
  const invalidate = useInvalidateQueue()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: QueueItemUpdateInput }) =>
      apiFetch<{ item: QueueItem }>(`${BASE}/items/${id}`, { method: 'PATCH', body: input }),
    onSuccess: () => invalidate()
  })
}

export function useReorderQueue() {
  const invalidate = useInvalidateQueue()
  return useMutation({
    mutationFn: (orderedIds: string[]) => apiFetch<QueueList>(`${BASE}/items/reorder`, { method: 'POST', body: { orderedIds } }),
    onSuccess: () => invalidate()
  })
}

export function useDispatchQueueItem() {
  const invalidate = useInvalidateQueue()
  return useMutation({
    mutationFn: ({ id, printerId, amsMapping }: { id: string } & QueueDispatchInput) =>
      apiFetch<{ item: QueueItem; job: PrintDispatchJob }>(`${BASE}/items/${id}/dispatch`, { method: 'POST', body: { printerId, amsMapping } }),
    onSuccess: () => invalidate()
  })
}

/**
 * Dry-run ("Check") a queued item: runs every pre-flight check a real Start runs (file resolved +
 * readable on the bridge, printer connected, guards, compatibility) and reports what would happen,
 * without uploading or starting. Read-only — does not invalidate the queue.
 */
export function useDryRunQueueItem() {
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<QueueDryRunResult>(`${BASE}/items/${id}/dispatch`, { method: 'POST', body: { dryRun: true } })
  })
}

export function useDispatchAll() {
  const invalidate = useInvalidateQueue()
  return useMutation({
    mutationFn: () => apiFetch<{ dispatched: Array<{ itemId: string; printerId: string }> }>(`${BASE}/items/dispatch-all`, { method: 'POST', body: {} }),
    onSuccess: () => invalidate()
  })
}

export function useRequeueItem() {
  const invalidate = useInvalidateQueue()
  return useMutation({
    mutationFn: (id: string) => apiFetch<{ item: QueueItem }>(`${BASE}/items/${id}/requeue`, { method: 'POST', body: {} }),
    onSuccess: () => invalidate()
  })
}

export function useRemoveQueueItem() {
  const invalidate = useInvalidateQueue()
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`${BASE}/items/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidate()
  })
}

export function useSaveQueueSettings() {
  const invalidate = useInvalidateQueue()
  return useMutation({
    mutationFn: (settings: QueueSettings) => apiFetch<{ settings: QueueSettings }>(`${BASE}/settings`, { method: 'PUT', body: settings }),
    onSuccess: () => invalidate()
  })
}
