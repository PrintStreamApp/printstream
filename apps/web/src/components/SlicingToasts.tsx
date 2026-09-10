/**
 * Global slicing status toasts, grouped: several slices in flight share one
 * toast with a line each, and the engine's progress wording, metadata and error
 * live behind the expand chevron.
 *
 * A slice belongs to the tab that started it (see the filter below), so this is
 * also where the "I'm leaving" signal for that ownership is sent from.
 */
import { useEffect, useMemo, useState } from 'react'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'
import StopCircleRoundedIcon from '@mui/icons-material/StopCircleRounded'
import { Typography } from '@mui/joy'
import type { SlicingJob, SlicingJobResponse } from '@printstream/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../lib/apiClient'
import { setAppBusy } from '../lib/appBusy'
import { formatLibraryFileName } from '../lib/libraryDisplay'
import {
  formatSlicingMetadataDisplay,
  formatSlicingProgress,
  getLatestSlicingProgressFrame,
  getSlicingJobStatusLabel,
  isActiveSlicingJob,
  slicingStatusColor
} from '../lib/slicingJobPresentation'
import { useRetrySlicingJob } from '../hooks/useRetrySlicingJob'
import { useSlicingJobs } from '../hooks/useSlicingJobs'
import { useSuppressedJobToastIds } from '../lib/dialogToastSuppression'
import { refreshSlicingJobs, seedSlicingJob } from '../lib/slicingJobsCache'
import { readTabSessionId, reportTabLeaving } from '../lib/tabSession'
import { jobBelongsInToastStack, useWatchedRunningJobIds } from '../lib/toastJobVisibility'
import { StatusToastIconAction } from './StatusToast'
import { StatusToastGroup, type StatusToastGroupItem } from './StatusToastGroup'

const MAX_ITEMS = 8
const FINISHED_AUTO_DISMISS_MS = 5_000
const SLICING_WORDING = { activeVerb: 'Slicing', noun: 'file', doneWord: 'sliced' }

export function SlicingToasts() {
  const queryClient = useQueryClient()
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const jobsQuery = useSlicingJobs({ suppressGlobalErrorToast: true })
  const cancelSlicing = useMutation({
    mutationFn: (job: SlicingJob) => apiFetch<SlicingJobResponse>(`/api/slicing/jobs/${job.id}/cancel`, { method: 'POST' }),
    onSuccess: (response) => {
      // The cancelled job comes back on the response, so the toast can flip to "Cancelled"
      // without the button waiting on a list refetch (see slicingJobsCache).
      seedSlicingJob(queryClient, response.job)
      refreshSlicingJobs(queryClient)
    }
  })
  // A retry re-arms the SAME job id, so an id the user had dismissed must come back: otherwise the
  // slice they just asked to re-run reports nothing at all.
  const retrySlicing = useRetrySlicingJob({
    onRetried: (jobId) => setDismissed((current) => {
      if (!current.has(jobId)) return current
      const next = new Set(current)
      next.delete(jobId)
      return next
    })
  })

  // Mounted with the toasts on purpose: this is the surface that owns a slice's fate in this tab,
  // so the "I'm leaving" signal lives beside it rather than in the app shell.
  useEffect(() => {
    const onPageHide = (event: PageTransitionEvent) => { if (!event.persisted) reportTabLeaving() }
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, [])

  const jobs = useMemo(() => jobsQuery.data?.jobs ?? [], [jobsQuery.data])

  // Leaving the page beacons `jobs/leaving`, which reaps this client's slices server-side,
  // so a reload really does destroy an active slice: it holds off an app update
  // (`lib/appStaleness.ts`). Ownership matters: an unowned job was started by a script or
  // an integration and survives this tab going away. Tracked from `jobs`, not
  // `visibleJobs`: dismissing the toast hides the slice, it does not stop it.
  useEffect(() => {
    const tabSessionId = readTabSessionId()
    setAppBusy('slicing', jobs.some((job) => isActiveSlicingJob(job) && job.ownerClientId === tabSessionId))
  }, [jobs])
  // ACCEPTED GAP, decided rather than overlooked: this component unmounts on a workspace
  // switch, which releases the hold while the slice is still running, so a pending update
  // can land ~1.5s later and reap it. Fixing it means moving slice ownership out of a view
  // component and into module state. Not worth that: switching workspaces is a deliberate
  // act, and the loss is one "Slice again" away. Revisit only if the hold is ever load
  // bearing for something unrecoverable.
  useEffect(() => () => setAppBusy('slicing', false), [])

  const suppressedJobIds = useSuppressedJobToastIds('slicing')
  // A failure is pinned only when this stack watched it run, so a cold load cannot resurrect a pile
  // of history. See `lib/toastJobVisibility.ts`.
  const watchedRunning = useWatchedRunningJobIds(jobs, isActiveSlicingJob)
  const visibleJobs = useMemo(() => {
    const now = Date.now()
    return jobs
      // A slice belongs to the tab that started it: its progress is that tab's business, and
      // toasting it in every other open tab (and in every teammate's) was noise about work they
      // did not ask for and cannot act on. A job with NO owner is not a browser's, a script or
      // an integration started it, so it stays visible to everyone rather than to nobody.
      .filter((job) => job.ownerClientId == null || job.ownerClientId === readTabSessionId())
      // Shared with the dispatch and delete stacks (`lib/toastJobVisibility.ts`): all three render
      // into one `StatusToastStack`, and a difference between them reads as one being broken.
      .filter((job) => jobBelongsInToastStack(job, {
        isActive: isActiveSlicingJob(job),
        isFailed: job.status === 'failed',
        watchedRunning: watchedRunning.has(job.id)
      }, now))
      // Once dismissed, stay dismissed, even for an "active" job. A stale/stuck toast (client
      // missed the completion event) would otherwise be un-dismissable, leaving only Cancel.
      .filter((job) => !dismissed.has(job.id))
      .filter((job) => !suppressedJobIds.has(job.id))
      .slice(0, MAX_ITEMS)
  }, [dismissed, jobs, suppressedJobIds, watchedRunning])

  useEffect(() => {
    setDismissed((current) => {
      const known = new Set(jobs.map((job) => job.id))
      let changed = false
      const next = new Set<string>()
      for (const id of current) {
        if (known.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : current
    })
  }, [jobs])

  useEffect(() => {
    // A FAILURE never auto-dismisses: it is the one outcome carrying an action (Retry) and a reason
    // the user has to read, and five seconds is not long enough to do either. It is exempt from the
    // recency window in `visibleJobs` too, so it really does stay until dismissed rather than going
    // quiet ninety seconds later on the user who stepped away. DispatchToasts draws the line in the
    // same place, through the same shared rule.
    const timers = jobs
      .filter((job) => job.status !== 'failed' && !isActiveSlicingJob(job) && !dismissed.has(job.id))
      .map((job) => window.setTimeout(() => {
        setDismissed((current) => new Set(current).add(job.id))
      }, FINISHED_AUTO_DISMISS_MS))
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [dismissed, jobs])

  const items = visibleJobs.map((job): StatusToastGroupItem => {
    const active = isActiveSlicingJob(job)
    const progressFrame = getLatestSlicingProgressFrame(job)
    const metadata = formatSlicingMetadataDisplay(job.metadata)
    const name = formatLibraryFileName(job.outputFileName ?? job.sourceFileName)
    return {
      id: job.id,
      title: name,
      statusLabel: getSlicingJobStatusLabel(job),
      color: slicingStatusColor(job.status),
      active,
      progress: active ? progressFrame?.totalPercent ?? null : null,
      summary: formatSlicingProgress(job, progressFrame),
      error: job.error,
      onDismiss: () => setDismissed((current) => new Set(current).add(job.id)),
      dismissLabel: `Dismiss the slicing notification for ${name}`,
      actions: (
        <>
          {job.status === 'failed' && (
            <StatusToastIconAction
              label={`Retry slicing ${name}`}
              color="primary"
              loading={retrySlicing.isPending && retrySlicing.variables === job.id}
              onClick={() => retrySlicing.mutate(job.id)}
            >
              <RefreshRoundedIcon />
            </StatusToastIconAction>
          )}
          {active && (
            <StatusToastIconAction
              label={`Cancel slicing ${name}`}
              color="danger"
              loading={cancelSlicing.isPending && cancelSlicing.variables?.id === job.id}
              onClick={() => cancelSlicing.mutate(job)}
            >
              <StopCircleRoundedIcon />
            </StatusToastIconAction>
          )}
        </>
      ),
      detail: metadata ? (
        <Typography level="body-xs" textColor="text.tertiary">{metadata}</Typography>
      ) : undefined
    }
  })

  if (items.length === 0) return null

  return (
    <StatusToastGroup
      items={items}
      wording={SLICING_WORDING}
      onDismissAll={() => setDismissed((current) => {
        const next = new Set(current)
        for (const job of visibleJobs) next.add(job.id)
        return next
      })}
      dismissAllLabel="Dismiss the slicing notifications"
    />
  )
}
