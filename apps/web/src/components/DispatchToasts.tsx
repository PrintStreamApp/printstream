import { useEffect, useMemo, useState } from 'react'
import { Box, Button, Chip, CircularProgress, Stack, Typography } from '@mui/joy'
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import type { PrintDispatchJob } from '@printstream/shared'
import { PrinterJobProgressBlock } from './PrinterJobProgressBlock'
import { apiFetch } from '../lib/apiClient'
import { isActiveDispatchJob, selectVisibleDispatchJobs } from '../lib/dispatchToastVisibility'
import { usePrintDispatchJobs } from '../hooks/usePrintDispatchJobs'
import { formatLibraryFileName } from '../lib/libraryDisplay'
import { buildTenantWorkspacePath, buildWorkspaceSelectionPath, parseWorkspacePathname } from '../lib/workspaceRoute'
import { toast } from '../lib/toast'
import { StatusToast, StatusToastDismissButton } from './StatusToast'

const FINISHED_AUTO_DISMISS_MS = 5_000

/** Global dispatch status toasts for long-running print sends. */
export function DispatchToasts() {
  const navigate = useNavigate()
  const location = useLocation()
  const tenantSlug = parseWorkspacePathname(location.pathname).tenantSlug
  const jobsPath = tenantSlug ? buildTenantWorkspacePath(tenantSlug, '/jobs') : buildWorkspaceSelectionPath()
  const queryClient = useQueryClient()
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const dispatchQuery = usePrintDispatchJobs({ idleRefetchInterval: 10_000 })
  const cancelDispatch = useMutation({
    mutationFn: (job: PrintDispatchJob) => apiFetch<{ job: PrintDispatchJob }>(`/api/print-dispatch/${job.id}/cancel`, { method: 'POST' }),
    onSuccess: (_data, job) => {
      if (job.status === 'failed') {
        toast.success('Failed dispatch moved to history')
      }
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['print-dispatch'] }),
        queryClient.invalidateQueries({ queryKey: ['jobs'] })
      ])
    }
  })
  const retryDispatch = useMutation({
    mutationFn: (id: string) => apiFetch<{ job: PrintDispatchJob }>(`/api/print-dispatch/${id}/retry`, { method: 'POST' }),
    onSuccess: (_data, id) => {
      setDismissed((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
      void queryClient.invalidateQueries({ queryKey: ['print-dispatch'] })
    }
  })

  const jobs = useMemo(() => dispatchQuery.data?.jobs ?? [], [dispatchQuery.data])
  const visibleJobs = useMemo(() => {
    return selectVisibleDispatchJobs(jobs, dismissed)
  }, [dismissed, jobs])

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
      .filter((job) => job.status !== 'failed' && !isActiveDispatchJob(job) && !dismissed.has(job.id))
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
        const active = isActive(job)
        const cancellable = active || job.status === 'failed'
        const retryable = job.status === 'failed'
        return (
          <StatusToast
            key={job.id}
            color={statusColor(job.status)}
            role={job.status === 'failed' ? 'alert' : 'status'}
            startDecorator={active ? <CircularProgress size="sm" determinate={false} /> : <StatusDot status={job.status} />}
          >
            <Stack spacing={1}>
              <Stack spacing={0.25} sx={{ flex: 1, minWidth: 0 }}>
                <PrinterJobProgressBlock
                  header={<Typography level="title-sm" noWrap sx={{ minWidth: 0, flex: 1 }}>{formatLibraryFileName(job.fileName)}</Typography>}
                  headerAside={(
                    <Chip size="sm" variant="soft" color={statusColor(job.status)} sx={{ flexShrink: 0 }}>
                      {statusLabel(job.status)}
                    </Chip>
                  )}
                  headerAction={(
                    <StatusToastDismissButton
                      ariaLabel="Dismiss dispatch notification"
                      onClick={() => setDismissed((current) => new Set(current).add(job.id))}
                    />
                  )}
                  determinate={active && job.uploadPercent != null}
                  value={active ? (job.uploadPercent ?? 0) : 0}
                  color={active ? 'primary' : 'neutral'}
                  footer={<Typography level="body-xs" textColor="text.tertiary" noWrap>{job.printerName} - {formatDispatchProgress(job)}</Typography>}
                />
                {job.error && (
                  <Typography level="body-xs" color="danger" noWrap>{job.error}</Typography>
                )}
              </Stack>

              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                justifyContent="flex-start"
                sx={{ width: '100%', flexWrap: 'wrap' }}
              >
                {cancellable && (
                  <Button
                    size="sm"
                    variant="plain"
                    color="danger"
                    loading={cancelDispatch.isPending && cancelDispatch.variables?.id === job.id}
                    onClick={() => cancelDispatch.mutate(job)}
                  >
                    Cancel
                  </Button>
                )}
                {retryable && (
                  <Button
                    size="sm"
                    variant="plain"
                    color="primary"
                    loading={retryDispatch.isPending && retryDispatch.variables === job.id}
                    onClick={() => retryDispatch.mutate(job.id)}
                  >
                    Retry
                  </Button>
                )}
                <Button size="sm" variant="soft" startDecorator={<HistoryRoundedIcon />} onClick={() => navigate(jobsPath)}>
                  Jobs
                </Button>
              </Stack>
            </Stack>
          </StatusToast>
        )
      })}
    </>
  )
}

function isActive(job: PrintDispatchJob): boolean {
  return isActiveDispatchJob(job)
}

function formatDispatchProgress(job: PrintDispatchJob): string {
  if (job.status === 'uploading' && job.uploadTotalBytes) {
    const percent = job.uploadPercent != null ? ` (${Math.round(job.uploadPercent)}%)` : ''
    const attempt = job.uploadAttempt > 1 && job.uploadMaxAttempts > 1 ? ` - attempt ${job.uploadAttempt} of ${job.uploadMaxAttempts}` : ''
    return `${formatBytes(job.uploadBytesSent)} of ${formatBytes(job.uploadTotalBytes)}${percent}${attempt}`
  }
  return job.progressMessage
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value >= 10 || unit === 0 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unit]}`
}

function statusLabel(status: PrintDispatchJob['status']): string {
  switch (status) {
    case 'queued':
      return 'Queued'
    case 'uploading':
      return 'Sending'
    case 'sent':
      return 'Sent'
    case 'cancelled':
      return 'Cancelled'
    case 'failed':
      return 'Failed'
  }
}

function statusColor(status: PrintDispatchJob['status']): 'neutral' | 'primary' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'queued':
      return 'neutral'
    case 'uploading':
      return 'primary'
    case 'sent':
      return 'success'
    case 'cancelled':
      return 'warning'
    case 'failed':
      return 'danger'
  }
}

function statusBorder(status: PrintDispatchJob['status']): string {
  switch (status) {
    case 'queued':
      return 'var(--joy-palette-neutral-600)'
    case 'uploading':
      return 'var(--joy-palette-primary-500)'
    case 'sent':
      return 'var(--joy-palette-success-500)'
    case 'cancelled':
      return 'var(--joy-palette-warning-500)'
    case 'failed':
      return 'var(--joy-palette-danger-500)'
  }
}

function StatusDot({ status }: { status: PrintDispatchJob['status'] }) {
  return (
    <Box
      aria-hidden
      sx={{
        width: 12,
        height: 12,
        mt: 0.5,
        borderRadius: '50%',
        backgroundColor: statusBorder(status),
        boxShadow: `0 0 0 3px color-mix(in srgb, ${statusBorder(status)} 22%, transparent)`
      }}
    />
  )
}
