/**
 * One slicing job by id (`GET /api/slicing/jobs/:id`: the full record, any age). The dialogs
 * that watch a job they just started (slice-then-print, calibration) use this instead of
 * scanning the list query: the list now carries only active/recent jobs, and a dialog left open
 * past that window must keep seeing its job.
 */
import { isActiveSlicingJob, type SlicingJobResponse } from '@printstream/shared'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../lib/apiClient'

/** Same wedge guard as the list fetch: see `useSlicingJobs`. */
const SLICING_JOB_TIMEOUT_MS = 20_000

export function useSlicingJob(jobId: string | null | undefined) {
  return useQuery({
    queryKey: ['slicing-job', jobId ?? null],
    queryFn: ({ signal }) => apiFetch<SlicingJobResponse>(`/api/slicing/jobs/${jobId}`, { signal, timeoutMs: SLICING_JOB_TIMEOUT_MS }),
    enabled: Boolean(jobId),
    // WS 'slicing' events invalidate this key on every transition/progress chunk (see
    // usePrinterWebSocket); the interval is the dropped-event safety net, like the list's.
    refetchInterval: (query) => {
      const job = query.state.data?.job
      return job && isActiveSlicingJob(job) ? 15_000 : false
    },
    refetchOnWindowFocus: true
  })
}
