/**
 * Global dispatch status toasts for long-running print sends.
 *
 * Sending to several printers at once is the normal case (and a P1S upload is
 * slow), so every in-flight send shares ONE grouped toast: a line each while
 * collapsed, full detail and the Cancel/Retry/Jobs buttons behind the chevron.
 * Status labels and progress wording come from `printersViewHelpers` so this
 * reads exactly like the Jobs view it links to.
 */
import { useEffect, useMemo, useState } from 'react'
import ArchiveRoundedIcon from '@mui/icons-material/ArchiveRounded'
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'
import StopCircleRoundedIcon from '@mui/icons-material/StopCircleRounded'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import type { PrintDispatchJob } from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { isActiveDispatchJob, selectVisibleDispatchJobs } from '../lib/dispatchToastVisibility'
import { usePrintDispatchJobs } from '../hooks/usePrintDispatchJobs'
import { formatLibraryFileName } from '../lib/libraryDisplay'
import { dispatchStatusColor, dispatchStatusLabel, formatDispatchProgress } from '../lib/printersViewHelpers'
import { buildWorkspacePath, buildWorkspaceSelectionPath, parseWorkspacePathname } from '../lib/workspaceRoute'
import { toast } from '../lib/toast'
import { StatusToastIconAction } from './StatusToast'
import { StatusToastGroup, type StatusToastGroupItem } from './StatusToastGroup'

const FINISHED_AUTO_DISMISS_MS = 5_000
const DISPATCH_WORDING = { activeVerb: 'Sending', noun: 'print', doneWord: 'sent' }

export function DispatchToasts() {
  const navigate = useNavigate()
  const location = useLocation()
  const workspaceSlug = parseWorkspacePathname(location.pathname).workspaceSlug
  const jobsPath = workspaceSlug ? buildWorkspacePath(workspaceSlug, '/jobs') : buildWorkspaceSelectionPath()
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

  const dismiss = (id: string) => setDismissed((current) => new Set(current).add(id))

  const items = visibleJobs.map((job): StatusToastGroupItem => {
    const active = isActiveDispatchJob(job)
    const color = dispatchStatusColor(job.status)
    return {
      id: job.id,
      title: formatLibraryFileName(job.fileName),
      statusLabel: dispatchStatusLabel(job.status),
      color,
      active,
      progress: active ? job.uploadPercent ?? null : null,
      summary: `${job.printerName} - ${formatDispatchProgress(job)}`,
      error: job.error,
      onDismiss: () => dismiss(job.id),
      dismissLabel: `Dismiss the notification for ${job.fileName}`,
      actions: (
        <>
          {job.status === 'failed' && (
            <StatusToastIconAction
              label={`Retry sending ${job.fileName}`}
              color="primary"
              loading={retryDispatch.isPending && retryDispatch.variables === job.id}
              onClick={() => retryDispatch.mutate(job.id)}
            >
              <RefreshRoundedIcon />
            </StatusToastIconAction>
          )}
          {/* Cancel and "move to history" are the same call on the server but
              read as different acts, so they get their own icon and wording
              rather than one control that means two things. */}
          {active && (
            <StatusToastIconAction
              label={`Cancel sending ${job.fileName}`}
              color="danger"
              loading={cancelDispatch.isPending && cancelDispatch.variables?.id === job.id}
              onClick={() => cancelDispatch.mutate(job)}
            >
              <StopCircleRoundedIcon />
            </StatusToastIconAction>
          )}
          {job.status === 'failed' && (
            <StatusToastIconAction
              label={`Move ${job.fileName} to history`}
              loading={cancelDispatch.isPending && cancelDispatch.variables?.id === job.id}
              onClick={() => cancelDispatch.mutate(job)}
            >
              <ArchiveRoundedIcon />
            </StatusToastIconAction>
          )}
        </>
      )
    }
  })

  if (items.length === 0) return null

  return (
    <StatusToastGroup
      items={items}
      wording={DISPATCH_WORDING}
      headerActions={(
        <StatusToastIconAction label="Open jobs" onClick={() => navigate(jobsPath)}>
          <HistoryRoundedIcon />
        </StatusToastIconAction>
      )}
      onDismissAll={() => setDismissed((current) => {
        const next = new Set(current)
        for (const job of visibleJobs) next.add(job.id)
        return next
      })}
      dismissAllLabel="Dismiss the print send notifications"
    />
  )
}
