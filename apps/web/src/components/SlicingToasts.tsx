/**
 * Global slicing status toasts, grouped: several slices in flight share one
 * toast with a line each, and the engine's progress wording, metadata and error
 * live behind the expand chevron.
 *
 * A slice belongs to the tab that started it (see the filter below), so this is
 * also where the "I'm leaving" signal for that ownership is sent from.
 */
import { useEffect, useMemo, useState } from 'react'
import StopCircleRoundedIcon from '@mui/icons-material/StopCircleRounded'
import { Typography } from '@mui/joy'
import type { SlicingJob, SlicingJobResponse } from '@printstream/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../lib/apiClient'
import { formatLibraryFileName } from '../lib/libraryDisplay'
import {
  formatSlicingMetadataDisplay,
  formatSlicingProgress,
  getLatestSlicingProgressFrame,
  getSlicingJobStatusLabel,
  isActiveSlicingJob,
  slicingStatusColor
} from '../lib/slicingJobPresentation'
import { useSlicingJobs } from '../hooks/useSlicingJobs'
import { useSuppressedJobToastIds } from '../lib/dialogToastSuppression'
import { refreshSlicingJobs, seedSlicingJob } from '../lib/slicingJobsCache'
import { readTabSessionId, reportTabLeaving } from '../lib/tabSession'
import { StatusToastIconAction } from './StatusToast'
import { StatusToastGroup, type StatusToastGroupItem } from './StatusToastGroup'

const RECENT_MS = 90_000
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

  // Mounted with the toasts on purpose: this is the surface that owns a slice's fate in this tab,
  // so the "I'm leaving" signal lives beside it rather than in the app shell.
  useEffect(() => {
    const onPageHide = (event: PageTransitionEvent) => { if (!event.persisted) reportTabLeaving() }
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, [])

  const jobs = useMemo(() => jobsQuery.data?.jobs ?? [], [jobsQuery.data])
  const suppressedJobIds = useSuppressedJobToastIds('slicing')
  const visibleJobs = useMemo(() => {
    const now = Date.now()
    return jobs
      // A slice belongs to the tab that started it: its progress is that tab's business, and
      // toasting it in every other open tab (and in every teammate's) was noise about work they
      // did not ask for and cannot act on. A job with NO owner is not a browser's, a script or
      // an integration started it, so it stays visible to everyone rather than to nobody.
      .filter((job) => job.ownerClientId == null || job.ownerClientId === readTabSessionId())
      .filter((job) => isActiveSlicingJob(job) || now - Date.parse(job.updatedAt) <= RECENT_MS)
      // Once dismissed, stay dismissed, even for an "active" job. A stale/stuck toast (client
      // missed the completion event) would otherwise be un-dismissable, leaving only Cancel.
      .filter((job) => !dismissed.has(job.id))
      .filter((job) => !suppressedJobIds.has(job.id))
      .slice(0, MAX_ITEMS)
  }, [dismissed, jobs, suppressedJobIds])

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
    const timers = jobs
      .filter((job) => !isActiveSlicingJob(job) && !dismissed.has(job.id))
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
      actions: active ? (
        <StatusToastIconAction
          label={`Cancel slicing ${name}`}
          color="danger"
          loading={cancelSlicing.isPending && cancelSlicing.variables?.id === job.id}
          onClick={() => cancelSlicing.mutate(job)}
        >
          <StopCircleRoundedIcon />
        </StatusToastIconAction>
      ) : undefined,
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
