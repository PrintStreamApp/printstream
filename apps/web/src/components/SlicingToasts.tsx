import { useEffect, useMemo, useState } from 'react'
import { Box, Button, Chip, CircularProgress, Stack, Typography } from '@mui/joy'
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
import { StatusToast, StatusToastDismissButton } from './StatusToast'

const RECENT_MS = 90_000
const MAX_TOASTS = 4
const FINISHED_AUTO_DISMISS_MS = 5_000

export function SlicingToasts() {
  const queryClient = useQueryClient()
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const jobsQuery = useSlicingJobs({ suppressGlobalErrorToast: true })
  const cancelSlicing = useMutation({
    mutationFn: (job: SlicingJob) => apiFetch<SlicingJobResponse>(`/api/slicing/jobs/${job.id}/cancel`, { method: 'POST' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['slicing-jobs'] })
    }
  })

  const jobs = useMemo(() => jobsQuery.data?.jobs ?? [], [jobsQuery.data])
  const suppressedJobIds = useSuppressedJobToastIds('slicing')
  const visibleJobs = useMemo(() => {
    const now = Date.now()
    return jobs
      .filter((job) => isActiveSlicingJob(job) || now - Date.parse(job.updatedAt) <= RECENT_MS)
      .filter((job) => !dismissed.has(job.id) || isActiveSlicingJob(job))
      .filter((job) => !suppressedJobIds.has(job.id))
      .slice(0, MAX_TOASTS)
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

  if (visibleJobs.length === 0) return null

  return (
    <>
      {visibleJobs.map((job) => {
        const active = isActiveSlicingJob(job)
        const progressFrame = getLatestSlicingProgressFrame(job)
        const progressPercent = progressFrame?.displayPercent ?? progressFrame?.totalPercent ?? null
        return (
          <StatusToast
            key={job.id}
            color={slicingStatusColor(job.status)}
            role={job.status === 'failed' ? 'alert' : 'status'}
            startDecorator={active ? (
              <CircularProgress
                size="sm"
                determinate={progressPercent != null}
                value={progressPercent ?? undefined}
              />
            ) : <StatusDot status={job.status} />}
          >
            <Stack spacing={0.5} sx={{ minWidth: 0 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0, flex: 1 }}>
                  <Typography level="title-sm" noWrap sx={{ minWidth: 0, flex: 1 }}>
                    {formatLibraryFileName(job.outputFileName ?? job.sourceFileName)}
                  </Typography>
                  <Chip size="sm" variant="soft" color={slicingStatusColor(job.status)} sx={{ flexShrink: 0 }}>
                    {getSlicingJobStatusLabel(job)}
                  </Chip>
                </Stack>
                <StatusToastDismissButton
                  ariaLabel="Dismiss slicing notification"
                  onClick={() => setDismissed((current) => new Set(current).add(job.id))}
                />
              </Stack>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                <Typography level="body-xs" textColor="text.tertiary" noWrap sx={{ minWidth: 0, flex: 1 }}>
                  {formatSlicingProgress(job, progressFrame)}
                </Typography>
                {active && (
                  <Button
                    size="sm"
                    variant="plain"
                    color="danger"
                    loading={cancelSlicing.isPending && cancelSlicing.variables?.id === job.id}
                    onClick={() => cancelSlicing.mutate(job)}
                    sx={{ flexShrink: 0, ml: 'auto' }}
                  >
                    Cancel
                  </Button>
                )}
              </Stack>
              {job.metadata && formatMetadataDisplay(job.metadata) && (
                <Typography level="body-xs" textColor="text.tertiary">
                  {formatMetadataDisplay(job.metadata)}
                </Typography>
              )}
              {job.error && <Typography level="body-xs" color="danger" noWrap>{job.error}</Typography>}
            </Stack>
          </StatusToast>
        )
      })}
    </>
  )
}

function formatMetadataDisplay(metadata: SlicingJob['metadata']): string {
  return formatSlicingMetadataDisplay(metadata)
}

function statusDotColor(status: SlicingJob['status']): string {
  switch (status) {
    case 'queued': return 'var(--joy-palette-neutral-500)'
    case 'preparing':
    case 'slicing':
    case 'saving': return 'var(--joy-palette-primary-500)'
    case 'ready': return 'var(--joy-palette-success-500)'
    case 'cancelled': return 'var(--joy-palette-warning-500)'
    case 'failed': return 'var(--joy-palette-danger-500)'
  }
}

function StatusDot({ status }: { status: SlicingJob['status'] }) {
  const color = statusDotColor(status)
  return (
    <Box
      aria-hidden
      sx={{
        width: 10,
        height: 10,
        mt: 0.5,
        borderRadius: '50%',
        backgroundColor: color,
        boxShadow: `0 0 0 4px color-mix(in srgb, ${color} 22%, transparent)`
      }}
    />
  )
}