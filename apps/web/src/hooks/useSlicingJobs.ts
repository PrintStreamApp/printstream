import type { SlicingJobsResponse } from '@printstream/shared'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../lib/apiClient'
import { isActiveSlicingJob } from '../lib/slicingJobPresentation'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from '../lib/workspaceScope'

export function useSlicingJobs(options?: { enabled?: boolean; suppressGlobalErrorToast?: boolean }) {
  const workspaceScopeKey = readCurrentWorkspaceScopeKey()
  return useQuery({
    queryKey: workspaceQueryKeys.slicingJobs(workspaceScopeKey),
    queryFn: ({ signal }) => apiFetch<SlicingJobsResponse>('/api/slicing/jobs', { signal }),
    enabled: options?.enabled ?? true,
    // Job state + progress are pushed over WS (resource.changed:'slicing' invalidates this key on
    // every transition/progress chunk), so polling is only a safety net for dropped events /
    // reconnects — a slow interval, not the old sub-second active poll that duplicated the WS stream.
    refetchInterval: (query) => query.state.data?.jobs.some(isActiveSlicingJob) ? 15_000 : 30_000,
    meta: options?.suppressGlobalErrorToast ? { suppressGlobalErrorToast: true } : undefined
  })
}