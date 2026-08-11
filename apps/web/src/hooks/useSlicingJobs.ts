import type { SlicingJobsResponse } from '@printstream/shared'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../lib/apiClient'
import { isActiveSlicingJob } from '../lib/slicingJobPresentation'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from '../lib/workspaceScope'

/**
 * A job-list fetch that has not settled in this long is treated as a stalled transport, aborted,
 * and retried. Generous against the poll interval on purpose — this is a wedge guard, not a
 * latency budget — but bounded, because a never-settling fetch here takes the whole key down:
 * the interval stops firing and every `invalidateQueries(['slicing-jobs'])` waits on it forever.
 */
const SLICING_JOBS_TIMEOUT_MS = 20_000

/**
 * The workspace's ACTIVE slicing jobs plus a short just-finished window — `GET /api/slicing/jobs`
 * (its counterpart route) stopped returning full history when the Jobs view's history section
 * moved to the server-paged `/api/jobs/history`. Consumers are the live surfaces only (the toast
 * stack, the in-progress section); anything needing one specific job — however old — uses
 * `useSlicingJob` instead.
 */
export function useSlicingJobs(options?: { enabled?: boolean; suppressGlobalErrorToast?: boolean }) {
  const workspaceScopeKey = readCurrentWorkspaceScopeKey()
  return useQuery({
    queryKey: workspaceQueryKeys.slicingJobs(workspaceScopeKey),
    queryFn: ({ signal }) => apiFetch<SlicingJobsResponse>('/api/slicing/jobs', { signal, timeoutMs: SLICING_JOBS_TIMEOUT_MS }),
    enabled: options?.enabled ?? true,
    // Job state + progress are pushed over WS (resource.changed:'slicing' invalidates this key on
    // every transition/progress chunk), so polling is only a safety net for dropped events /
    // reconnects — a slow interval, not the old sub-second active poll that duplicated the WS stream.
    refetchInterval: (query) => query.state.data?.jobs.some(isActiveSlicingJob) ? 15_000 : 30_000,
    // If a slice finishes while the tab is backgrounded, the WS event can be missed and the interval
    // is paused — refetch on focus so a returning user never sees a toast frozen mid-progress.
    refetchOnWindowFocus: true,
    meta: options?.suppressGlobalErrorToast ? { suppressGlobalErrorToast: true } : undefined
  })
}