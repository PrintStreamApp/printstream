/**
 * Global toasts for long-running deletes (library sweeps, printer removals),
 * grouped so a batch of them costs one toast with a line each.
 *
 * Renders into the app's single `StatusToastStack` as a child of it, it must
 * not portal a stack of its own, or two stacks land in the same corner.
 */
import { useEffect, useMemo, useState } from 'react'
import type { DeleteOperationJob } from '@printstream/shared'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../lib/apiClient'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from '../lib/workspaceScope'
import { StatusToastGroup, type StatusToastGroupItem } from './StatusToastGroup'

const RECENT_MS = 90_000
const MAX_ITEMS = 8
const FINISHED_AUTO_DISMISS_MS = 5_000
const DELETE_WORDING = { activeVerb: 'Deleting', noun: 'item', doneWord: 'deleted' }

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
      .slice(0, MAX_ITEMS)
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

  const items = visibleJobs.map((job): StatusToastGroupItem => ({
    id: job.id,
    title: job.summaryLabel,
    statusLabel: statusLabel(job.status),
    color: statusColor(job.status),
    active: isActive(job),
    // A running delete at 0% has an extent it has not moved through yet; showing
    // that as a determinate bar draws an empty track that reads as stalled.
    progress: isActive(job) && (job.progressPercent ?? 0) <= 0 ? null : job.progressPercent,
    summary: `${job.targetName} - ${job.progressMessage}`,
    error: job.error,
    onDismiss: () => setDismissed((current) => new Set(current).add(job.id)),
    dismissLabel: `Dismiss the delete notification for ${job.targetName}`
  }))

  if (items.length === 0) return null

  return (
    <StatusToastGroup
      items={items}
      wording={DELETE_WORDING}
      onDismissAll={() => setDismissed((current) => {
        const next = new Set(current)
        for (const job of visibleJobs) next.add(job.id)
        return next
      })}
      dismissAllLabel="Dismiss the delete notifications"
    />
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
