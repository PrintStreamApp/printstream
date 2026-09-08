/**
 * "Run that failed slice again" (`POST /api/slicing/jobs/:id/retry`), shared by every surface a
 * failure can surface on: the toast stack, the slice/result dialogs, and the Jobs history card.
 *
 * One hook rather than a mutation per surface because a failed slice is visible in three places at
 * once and which one the user is looking at is an accident of what else they had open (an open
 * slice dialog SUPPRESSES the toast, `lib/dialogToastSuppression.ts`). They must all offer the same
 * act, and all reflect it the same way.
 *
 * The retry keeps the job's ID, so seeding the response is what makes every one of those surfaces
 * follow the new attempt on the next frame instead of after a list refetch. Follows the module rule
 * in `lib/slicingJobsCache.ts`: seed from the response, refresh the list in the background, never
 * await it inside `onSuccess`.
 *
 * Counterpart: `slicingJobs.retry` in `apps/api/src/lib/slicing-jobs.ts`.
 */
import type { SlicingJobResponse } from '@printstream/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../lib/apiClient'
import { refreshSlicingJobs, seedSlicingJob } from '../lib/slicingJobsCache'
import { readTabSessionId } from '../lib/tabSession'

export function useRetrySlicingJob(options?: { onRetried?: (jobId: string) => void }) {
  const queryClient = useQueryClient()
  const onRetried = options?.onRetried
  return useMutation({
    // The tab id re-homes the job onto whoever is retrying: it decides which tab is shown the
    // toast and whose departure cancels the slice, and both must follow the retry rather than
    // stay with the tab that happened to fail.
    mutationFn: (jobId: string) => apiFetch<SlicingJobResponse>(`/api/slicing/jobs/${jobId}/retry`, {
      method: 'POST',
      body: { ownerClientId: readTabSessionId() }
    }),
    onSuccess: (response, jobId) => {
      seedSlicingJob(queryClient, response.job)
      refreshSlicingJobs(queryClient)
      onRetried?.(jobId)
    }
    // Deliberately NO `onError`. A retry is refused often enough to need saying so (503 with no
    // slicer, 409 with the queue full, 404 once the job has aged out), and it already is: the app's
    // `MutationCache` reports every mutation failure (`main.tsx`), and TanStack Query calls that
    // cache-level handler as well as a mutation's own, so adding one here toasted the same refusal
    // twice. Worse for a disabled-plugin error, where the global handler rewrites the message and
    // the two no longer merge into one entry. A bespoke message opts out with
    // `meta: { suppressGlobalErrorToast: true }` instead of adding a second handler.
  })
}
