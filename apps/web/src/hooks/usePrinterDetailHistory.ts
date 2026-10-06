/**
 * Persisted controls and visible jobs for one printer's detail history.
 *
 * The page owns rendering and deletion. This hook keeps the sort, filters,
 * pagination, and mobile list fallback in one place so route changes only
 * change which jobs are selected, not the saved directory preferences.
 */
import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { PrintJob } from '@printstream/shared'
import type { DirectorySortDirection, DirectoryViewMode } from '../components/DirectoryControls'
import { useLocalStorageState } from './useLocalStorageState'
import { usePersistentState } from './usePersistentState'
import { useMobileViewport } from '../components/useMobileViewport'
import { formatLibraryFileName } from '../lib/libraryDisplay'
import { formatDateTime } from '../lib/time'
import { HISTORY_RESULTS, parseHistoryViewMode } from '../lib/printersViewHelpers'
import {
  HISTORY_PAGE_SIZE_OPTIONS,
  PRINTER_HISTORY_PAGE_SIZE_KEY,
  PRINTER_HISTORY_RESULT_FILTER_KEY,
  PRINTER_HISTORY_SORT_DIR_KEY,
  PRINTER_HISTORY_VIEW_MODE_KEY
} from '../lib/printerViewConstants'

const HISTORY_PAGE_SIZES = new Set<number>(HISTORY_PAGE_SIZE_OPTIONS)
const HISTORY_RESULT_SET = new Set<PrintJob['result']>(HISTORY_RESULTS)

/** Accept only persisted sort directions the history controls can render. */
function sanitizeHistorySortDirection(value: unknown): DirectorySortDirection {
  return value === 'asc' ? 'asc' : 'desc'
}

/** Drop stale result tokens from a saved filter without resetting valid choices. */
function sanitizeHistoryResults(value: unknown): PrintJob['result'][] {
  return Array.isArray(value)
    ? value.filter((entry): entry is PrintJob['result'] => HISTORY_RESULT_SET.has(entry as PrintJob['result']))
    : []
}

function sanitizeHistoryPageSize(value: unknown): number {
  return typeof value === 'number' && HISTORY_PAGE_SIZES.has(value) ? value : HISTORY_PAGE_SIZE_OPTIONS[0]
}

/** Select and sort finished jobs for the route printer; the caller's array is never mutated. */
export function selectPrinterHistoryJobs(
  jobs: readonly PrintJob[] | undefined,
  printerId: string | undefined,
  sortDirection: DirectorySortDirection
): PrintJob[] {
  if (!printerId) return []
  return (jobs ?? [])
    .filter((job) => job.printerId === printerId && job.finishedAt)
    .sort((left, right) => sortDirection === 'desc'
      ? (right.finishedAt ?? '').localeCompare(left.finishedAt ?? '')
      : (left.finishedAt ?? '').localeCompare(right.finishedAt ?? ''))
}

/** Own the detail history controls and derive the current page from live jobs. */
export function usePrinterDetailHistory(jobs: readonly PrintJob[] | undefined, printerId: string | undefined) {
  const [detailHistorySearch, setDetailHistorySearch] = useState('')
  const deferredDetailHistorySearch = useDeferredValue(detailHistorySearch)
  const [detailHistoryResults, setDetailHistoryResults] = usePersistentState<PrintJob['result'][]>(
    PRINTER_HISTORY_RESULT_FILTER_KEY,
    [],
    sanitizeHistoryResults
  )
  const [detailHistorySortDirection, setDetailHistorySortDirection] = usePersistentState<DirectorySortDirection>(
    PRINTER_HISTORY_SORT_DIR_KEY,
    'desc',
    sanitizeHistorySortDirection
  )
  const [detailHistoryPage, setDetailHistoryPage] = useState(0)
  const [detailHistoryPageSize, setDetailHistoryPageSize] = usePersistentState<number>(
    PRINTER_HISTORY_PAGE_SIZE_KEY,
    HISTORY_PAGE_SIZE_OPTIONS[0],
    sanitizeHistoryPageSize
  )
  const [detailHistoryViewMode, setDetailHistoryViewMode] = useLocalStorageState<DirectoryViewMode>(
    PRINTER_HISTORY_VIEW_MODE_KEY,
    'list',
    parseHistoryViewMode,
    String
  )
  const isMobileViewport = useMobileViewport()

  const selectedPrinterJobs = useMemo(
    () => selectPrinterHistoryJobs(jobs, printerId, detailHistorySortDirection),
    [detailHistorySortDirection, jobs, printerId]
  )
  const filteredSelectedPrinterJobs = useMemo(() => {
    const activeResults = new Set(detailHistoryResults)
    const normalizedSearch = deferredDetailHistorySearch.trim().toLowerCase()
    return selectedPrinterJobs.filter((job) => {
      if (activeResults.size > 0 && !activeResults.has(job.result)) return false
      if (!normalizedSearch) return true
      const searchHaystack = [
        formatLibraryFileName(job.fileName || job.jobName || 'Untitled'),
        job.result,
        formatDateTime(job.startedAt)
      ].join(' ').toLowerCase()
      return searchHaystack.includes(normalizedSearch)
    })
  }, [deferredDetailHistorySearch, detailHistoryResults, selectedPrinterJobs])
  const detailHistoryPageCount = Math.max(1, Math.ceil(filteredSelectedPrinterJobs.length / detailHistoryPageSize))
  const safeDetailHistoryPage = Math.min(detailHistoryPage, detailHistoryPageCount - 1)
  const activeDetailHistoryFilterCount = Number(detailHistoryResults.length > 0)
  const effectiveDetailHistoryViewMode: DirectoryViewMode = isMobileViewport ? 'list' : detailHistoryViewMode
  const visibleSelectedPrinterJobs = useMemo(() => {
    const start = safeDetailHistoryPage * detailHistoryPageSize
    return filteredSelectedPrinterJobs.slice(start, start + detailHistoryPageSize)
  }, [detailHistoryPageSize, filteredSelectedPrinterJobs, safeDetailHistoryPage])

  useEffect(() => {
    setDetailHistoryPage((current) => Math.min(current, detailHistoryPageCount - 1))
  }, [detailHistoryPageCount])

  function clearDetailHistoryFilters() {
    setDetailHistoryResults([])
  }

  return {
    detailHistorySearch,
    setDetailHistorySearch,
    detailHistoryResults,
    setDetailHistoryResults,
    detailHistorySortDirection,
    setDetailHistorySortDirection,
    setDetailHistoryPage,
    detailHistoryPageSize,
    setDetailHistoryPageSize,
    setDetailHistoryViewMode,
    selectedPrinterJobs,
    filteredSelectedPrinterJobs,
    detailHistoryPageCount,
    safeDetailHistoryPage,
    activeDetailHistoryFilterCount,
    effectiveDetailHistoryViewMode,
    visibleSelectedPrinterJobs,
    clearDetailHistoryFilters
  }
}
