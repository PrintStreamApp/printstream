import { useEffect, useMemo, useState } from 'react'
import { Box, Chip, CircularProgress, LinearProgress, Stack, Typography } from '@mui/joy'
import type { DeleteOperationJob } from '@printstream/shared'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../lib/apiClient'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from '../lib/workspaceScope'
import { StatusToast, StatusToastDismissButton, StatusToastStack } from './StatusToast'

const RECENT_MS = 90_000
const MAX_TOASTS = 4
const FINISHED_AUTO_DISMISS_MS = 5_000

export function DeleteOperationToasts() {
  const workspaceScopeKey = readCurrentWorkspaceScopeKey()
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const jobsQuery = useQuery({
    queryKey: workspaceQueryKeys.deleteOperations(workspaceScopeKey),
    queryFn: () => apiFetch<{ jobs: DeleteOperationJob[] }>('/api/delete-operations'),
    refetchInterval: (query) => query.state.data?.jobs.some((job) => isActive(job)) ? 2_000 : 10_000
  })

  const jobs = useMemo(() => jobsQuery.data?.jobs ?? [], [jobsQuery.data])
  const visibleJobs = useMemo(() => {
    const now = Date.now()
    return jobs
      .filter((job) => isActive(job) || now - Date.parse(job.updatedAt) <= RECENT_MS)
      .filter((job) => !dismissed.has(job.id) || isActive(job))
      .slice(0, MAX_TOASTS)
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
      .filter((job) => !isActive(job) && !dismissed.has(job.id))
      .map((job) => window.setTimeout(() => {
        setDismissed((current) => new Set(current).add(job.id))
      }, FINISHED_AUTO_DISMISS_MS))
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [dismissed, jobs])

  if (visibleJobs.length === 0) return null

  return (
    <StatusToastStack>
        {visibleJobs.map((job) => (
          <StatusToast
            key={job.id}
            color={statusColor(job.status)}
            role={job.status === 'failed' ? 'alert' : 'status'}
            startDecorator={isActive(job) ? <CircularProgress size="sm" determinate={false} /> : <StatusDot status={job.status} />}
          >
            <Stack spacing={1}>
              <Stack spacing={0.25} sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                  <Typography level="title-sm" noWrap sx={{ minWidth: 0, flex: 1 }}>
                    {job.summaryLabel}
                  </Typography>
                  <Chip size="sm" variant="soft" color={statusColor(job.status)} sx={{ flexShrink: 0 }}>
                    {statusLabel(job.status)}
                  </Chip>
                  <StatusToastDismissButton
                    ariaLabel="Dismiss delete notification"
                    onClick={() => setDismissed((current) => new Set(current).add(job.id))}
                  />
                </Stack>
                <Typography level="body-xs" textColor="text.tertiary" noWrap>
                  {job.targetName} - {job.progressMessage}
                </Typography>
                {job.error && <Typography level="body-xs" color="danger" noWrap>{job.error}</Typography>}
              </Stack>

              {job.progressPercent != null && (
                <LinearProgress
                  determinate={!isActive(job) || job.progressPercent > 0}
                  value={job.progressPercent}
                  sx={{ '--LinearProgress-thickness': '6px' }}
                />
              )}
            </Stack>
          </StatusToast>
        ))}
    </StatusToastStack>
  )
}

function isActive(job: DeleteOperationJob): boolean {
  return job.status === 'queued' || job.status === 'running'
}

function statusLabel(status: DeleteOperationJob['status']): string {
  switch (status) {
    case 'queued':
      return 'Queued'
    case 'running':
      return 'Deleting'
    case 'completed':
      return 'Done'
    case 'failed':
      return 'Failed'
  }
}

function statusColor(status: DeleteOperationJob['status']): 'neutral' | 'primary' | 'success' | 'danger' {
  switch (status) {
    case 'queued':
      return 'neutral'
    case 'running':
      return 'primary'
    case 'completed':
      return 'success'
    case 'failed':
      return 'danger'
  }
}

function statusGlow(status: DeleteOperationJob['status']): string {
  switch (status) {
    case 'queued':
      return 'rgba(148, 163, 184, 0.24)'
    case 'running':
      return 'rgba(59, 130, 246, 0.28)'
    case 'completed':
      return 'rgba(34, 197, 94, 0.24)'
    case 'failed':
      return 'rgba(239, 68, 68, 0.24)'
  }
}

function StatusDot({ status }: { status: DeleteOperationJob['status'] }) {
  return (
    <Box
      sx={{
        width: 10,
        height: 10,
        borderRadius: '50%',
        backgroundColor: statusGlow(status).replace('0.24', '1').replace('0.28', '1'),
        boxShadow: `0 0 0 4px ${statusGlow(status)}`
      }}
    />
  )
}