import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import type { SlicingJob, SlicingJobsResponse } from '@printstream/shared'
import { refreshSlicingJobs, seedSlicingJob } from './slicingJobsCache.js'
import { workspaceQueryKeys } from './workspaceScope.js'

// No `window` in this runner, so `readCurrentWorkspaceScopeKey()` resolves to the ambient scope.
const SCOPE_KEY = workspaceQueryKeys.slicingJobs('ambient')

function buildJob(overrides: Partial<SlicingJob> = {}): SlicingJob {
  return {
    id: 'job-1',
    sourceFileId: 'file-1',
    sourceFileName: 'widget.3mf',
    slicerTargetId: 'bambustudio-2-7-1-62',
    outputFileId: null,
    outputFileName: null,
    target: { mode: 'manualProfile', printerModel: 'H2D', printerProfileId: 'printer-profile-1' },
    plate: 1,
    status: 'queued',
    queuePosition: 1,
    slicerName: 'Bambu Studio',
    metadata: undefined,
    output: [],
    error: null,
    createdAt: '2026-07-28T05:20:01.364Z',
    updatedAt: '2026-07-28T05:20:01.364Z',
    startedAt: null,
    finishedAt: null,
    cancelRequested: false,
    ...overrides
  }
}

function buildClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
}

/** Let queued microtasks and timers run so a promise that CAN settle has settled. */
async function settleTasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

test('seedSlicingJob puts a newly created job at the front of the cached list', () => {
  const queryClient = buildClient()
  const existing = buildJob({ id: 'older', createdAt: '2026-07-28T05:00:00.000Z' })
  queryClient.setQueryData<SlicingJobsResponse>(SCOPE_KEY, { jobs: [existing] })

  seedSlicingJob(queryClient, buildJob({ id: 'newest' }))

  assert.deepEqual(queryClient.getQueryData<SlicingJobsResponse>(SCOPE_KEY)?.jobs.map((job) => job.id), ['newest', 'older'])
})

test('seedSlicingJob replaces an existing entry rather than duplicating the row', () => {
  const queryClient = buildClient()
  queryClient.setQueryData<SlicingJobsResponse>(SCOPE_KEY, { jobs: [buildJob({ id: 'job-1', status: 'queued' })] })

  seedSlicingJob(queryClient, buildJob({ id: 'job-1', status: 'cancelled' }))

  const jobs = queryClient.getQueryData<SlicingJobsResponse>(SCOPE_KEY)?.jobs ?? []
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0]?.status, 'cancelled')
})

test('seedSlicingJob leaves a cold cache alone instead of inventing a one-job list', () => {
  const queryClient = buildClient()

  seedSlicingJob(queryClient, buildJob())

  assert.equal(queryClient.getQueryData<SlicingJobsResponse>(SCOPE_KEY), undefined)
})

test('a mutation that refreshes the job list settles even while the list fetch is wedged', async () => {
  const queryClient = buildClient()
  // A list fetch that never settles: the real-world shape is a large response whose transport
  // stalls after committing, which leaves the query `fetching` forever.
  const observer = new QueryObserver<SlicingJobsResponse>(queryClient, {
    queryKey: SCOPE_KEY,
    queryFn: () => new Promise<SlicingJobsResponse>(() => {})
  })
  const unsubscribe = observer.subscribe(() => {})
  await settleTasks()

  // The hazard this module exists to prevent: awaiting the invalidation never returns, and
  // query-core holds the mutation `pending` until every onSuccess promise settles, so the
  // button spins forever over a slice the server already finished.
  let awaitedInvalidationSettled = false
  void queryClient.invalidateQueries({ queryKey: ['slicing-jobs'] }).then(() => { awaitedInvalidationSettled = true })

  let refreshingMutationSettled = false
  const mutation = queryClient.getMutationCache().build<SlicingJob, Error, void, unknown>(queryClient, {
    mutationFn: async () => buildJob(),
    onSuccess: () => { refreshSlicingJobs(queryClient) }
  })
  void mutation.execute(undefined).then(() => { refreshingMutationSettled = true })

  await settleTasks()
  unsubscribe()

  assert.equal(awaitedInvalidationSettled, false, 'awaiting the invalidation blocks while the list fetch is wedged')
  assert.equal(refreshingMutationSettled, true, 'the mutation must not wait on the list refetch')
})
