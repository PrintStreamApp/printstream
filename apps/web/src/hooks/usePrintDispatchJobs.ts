import { createContext, createElement, useContext, type ReactNode } from 'react'
import type { PrintDispatchJob } from '@printstream/shared'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { apiFetch } from '../lib/apiClient'
import { isActiveDispatchJob } from '../lib/dispatchToastVisibility'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from '../lib/workspaceScope'

const PRINT_DISPATCH_STALE_TIME_MS = 10_000

const printDispatchJobsQueryContext = createContext<UseQueryResult<{ jobs: PrintDispatchJob[] }> | null>(null)

interface UsePrintDispatchJobsOptions {
  enabled?: boolean
  idleRefetchInterval?: number | false
  suppressGlobalErrorToast?: boolean
}

export function PrintDispatchJobsQueryProvider(
  { children, value }: { children: ReactNode; value: UseQueryResult<{ jobs: PrintDispatchJob[] }> }
) {
  return createElement(printDispatchJobsQueryContext.Provider, { value }, children)
}

export function usePrintDispatchJobs(options: UsePrintDispatchJobsOptions = {}) {
  const sharedQuery = useContext(printDispatchJobsQueryContext)
  const workspaceScopeKey = readCurrentWorkspaceScopeKey()
  const {
    enabled = true,
    idleRefetchInterval = false,
    suppressGlobalErrorToast = false
  } = options

  const localQuery = useQuery({
    queryKey: workspaceQueryKeys.printDispatch(workspaceScopeKey),
    queryFn: ({ signal }) => apiFetch<{ jobs: PrintDispatchJob[] }>('/api/print-dispatch', { signal }),
    enabled: !sharedQuery && enabled,
    staleTime: PRINT_DISPATCH_STALE_TIME_MS,
    meta: suppressGlobalErrorToast ? { suppressGlobalErrorToast: true } : undefined,
    refetchInterval: (query) =>
      query.state.data?.jobs.some((job) => isActiveDispatchJob(job)) ? 2_000 : idleRefetchInterval
  })

  return sharedQuery ?? localQuery
}

export function isPrinterDispatchUploading(jobs: readonly PrintDispatchJob[], printerId: string): boolean {
  return jobs.some((job) => job.printerId === printerId && job.status === 'uploading')
}

export function usePrinterDispatchUploadActive(printerId: string | null | undefined, options: UsePrintDispatchJobsOptions = {}): boolean {
  const normalizedPrinterId = typeof printerId === 'string' ? printerId : ''
  const query = usePrintDispatchJobs({
    ...options,
    enabled: (options.enabled ?? true) && normalizedPrinterId.length > 0,
    suppressGlobalErrorToast: options.suppressGlobalErrorToast ?? true
  })

  return normalizedPrinterId.length > 0 && isPrinterDispatchUploading(query.data?.jobs ?? [], normalizedPrinterId)
}