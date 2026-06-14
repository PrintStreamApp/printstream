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
    refetchInterval: (query) => query.state.data?.jobs.some(isActiveSlicingJob) ? 2_000 : 10_000,
    meta: options?.suppressGlobalErrorToast ? { suppressGlobalErrorToast: true } : undefined
  })
}