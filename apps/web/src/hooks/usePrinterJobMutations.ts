/**
 * Print-history actions used by PrintersView.
 *
 * The page owns the confirmation and print-flow dialogs. This hook owns the
 * reprint/delete requests, pending replay identity, and affected query refreshes.
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { extractErrorMessage, type PrintDispatchJob } from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { toast } from '../lib/toast'
import { workspaceQueryKeys } from '../lib/workspaceScope'

/** Keep job actions and their cache effects together for the active workspace. */
export function usePrinterJobMutations(workspaceScopeKey: string) {
  const queryClient = useQueryClient()
  const [replayingJobId, setReplayingJobId] = useState<string | null>(null)

  const restartJob = useMutation({
    mutationFn: async (input: { jobId: string; body?: Record<string, unknown> }) => {
      setReplayingJobId(input.jobId)
      return await apiFetch<void | { job: PrintDispatchJob }>(`/api/jobs/${input.jobId}/reprint`, {
        method: 'POST',
        ...(input.body ? { body: input.body } : {})
      })
    },
    onSettled: () => {
      setReplayingJobId(null)
    },
    onSuccess: () => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['jobs'] }),
        queryClient.invalidateQueries({ queryKey: ['print-dispatch'] }),
        queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.printerStatus(workspaceScopeKey) })
      ])
    }
  })

  const deleteHistoryJob = useMutation({
    mutationFn: (jobId: string) => apiFetch<void>(`/api/jobs/${jobId}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('History entry deleted')
      void queryClient.invalidateQueries({ queryKey: ['jobs'] })
    },
    onError: (error) => {
      toast.error(extractErrorMessage(error))
    }
  })

  return { restartJob, deleteHistoryJob, replayingJobId }
}
