/**
 * Cache plumbing for the workspace's slicing-job list, shared by every surface that STARTS or
 * cancels a slice (library, printers, orders, print-queue, the toast stack).
 *
 * It exists to enforce one rule: **a mutation must never await the job list.** TanStack keeps a
 * mutation `isPending` until every `onSuccess` promise settles (query-core `Mutation.execute`), so
 * `await queryClient.invalidateQueries(['slicing-jobs'])` inside `onSuccess` ties the Slice
 * button's spinner — and the result/print dialog opened after it — to a workspace-wide list
 * request. That request is large (every job, with its CLI log) and only gets larger with history,
 * so the user waits on it for no gain: the slice is already queued server-side by then. When the
 * transport stalls it never settles at all, and the button spins forever over a slice that
 * actually succeeded.
 *
 * So: seed the created job from the POST response (`seedSlicingJob`) and let the list catch up in
 * the background (`refreshSlicingJobs`).
 *
 * Counterparts: `useSlicingJobs` reads this key; `GET /api/slicing/jobs` fills it.
 */
import type { QueryClient } from '@tanstack/react-query'
import type { SlicingJob, SlicingJobsResponse } from '@printstream/shared'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from './workspaceScope'

/**
 * Place a job the API just returned into the current workspace's cached list, so a dialog that
 * looks the job up by id finds it on its first render instead of after a refetch.
 *
 * No-op when nothing is cached yet: writing a one-entry list there would tell every reader that
 * the workspace's other jobs are gone. Insertion is at the front to match the API's `createdAt`
 * DESC ordering, and replaces any existing entry so a re-seed cannot duplicate the row.
 */
export function seedSlicingJob(queryClient: QueryClient, job: SlicingJob): void {
  queryClient.setQueryData<SlicingJobsResponse>(
    workspaceQueryKeys.slicingJobs(readCurrentWorkspaceScopeKey()),
    (current) => (current
      ? { ...current, jobs: [job, ...current.jobs.filter((entry) => entry.id !== job.id)] }
      : current)
  )
}

/**
 * Refresh the job list in the background. Deliberately not awaited (see the module header) and
 * deliberately keyed on the bare `slicing-jobs` prefix, which matches every workspace scope —
 * mirroring how the WS `resource.changed` handler invalidates it.
 */
export function refreshSlicingJobs(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['slicing-jobs'] })
}
