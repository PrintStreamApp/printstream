/**
 * Search / status-filter / status-grouping / pagination state for the Queue view,
 * persisted across reloads under stable `print-queue.*` keys. Sort is intentionally
 * locked to "Manual order" — the backlog is hand-ordered (drag / move up-down), so
 * exposing other sort fields would fight the manual order. Display only: filtering and
 * grouping never change the underlying order used by reorder.
 */
import { useMemo, useState } from 'react'
import type { QueueItem, QueueItemStatus } from '@printstream/shared'
import { useLocalStorageState } from '../../hooks/useLocalStorageState'

export const QUEUE_GROUP_OPTIONS = [
  { value: 'none', label: 'No grouping' },
  { value: 'status', label: 'Status' }
] as const
export type QueueGroupBy = (typeof QUEUE_GROUP_OPTIONS)[number]['value']

export const QUEUE_SORT_OPTIONS = [{ value: 'manual', label: 'Manual order' }] as const
export type QueueSortBy = (typeof QUEUE_SORT_OPTIONS)[number]['value']

export const QUEUE_PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const
export type QueuePageSize = (typeof QUEUE_PAGE_SIZE_OPTIONS)[number]

export const QUEUE_STATUS_LABELS: Record<QueueItemStatus, string> = {
  queued: 'Queued',
  held: 'Held',
  dispatching: 'Starting',
  printing: 'Printing',
  failed: 'Failed',
  done: 'Done'
}
const STATUS_ORDER: QueueItemStatus[] = ['queued', 'held', 'dispatching', 'printing', 'failed', 'done']
const STATUS_SET = new Set<QueueItemStatus>(STATUS_ORDER)

function parseGroup(raw: string): QueueGroupBy | null {
  return raw === 'status' || raw === 'none' ? raw : null
}
function parsePageSize(raw: string): QueuePageSize | null {
  const value = Number(raw)
  return (QUEUE_PAGE_SIZE_OPTIONS as readonly number[]).includes(value) ? (value as QueuePageSize) : null
}
function parseStatuses(raw: string): QueueItemStatus[] | null {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((value): value is QueueItemStatus => STATUS_SET.has(value)) : null
  } catch {
    return null
  }
}

export interface QueueGroup {
  key: string
  label: string
  items: QueueItem[]
}

export interface QueueDirectory {
  search: string
  setSearch: (value: string) => void
  group: QueueGroupBy
  setGroup: (value: QueueGroupBy) => void
  statuses: QueueItemStatus[]
  setStatuses: (value: QueueItemStatus[]) => void
  pageSize: QueuePageSize
  setPageSize: (value: QueuePageSize) => void
  page: number
  setPage: (updater: (current: number) => number) => void
  total: number
  grouped: boolean
  groups: QueueGroup[]
  pageItems: QueueItem[]
  start: number
  statusFacets: QueueItemStatus[]
  activeFilterCount: number
  clearFilters: () => void
}

export function useQueueDirectory(items: QueueItem[]): QueueDirectory {
  const [search, setSearch] = useState('')
  const [group, setGroup] = useLocalStorageState<QueueGroupBy>('print-queue.group', 'none', parseGroup, String)
  const [pageSize, setPageSize] = useLocalStorageState<QueuePageSize>('print-queue.pageSize', 25, parsePageSize, String)
  const [statuses, setStatuses] = useLocalStorageState<QueueItemStatus[]>('print-queue.statuses', [], parseStatuses, JSON.stringify)
  const [page, setPage] = useState(1)

  const statusFacets = useMemo(() => STATUS_ORDER.filter((status) => items.some((item) => item.status === status)), [items])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return items.filter((item) => {
      if (statuses.length > 0 && !statuses.includes(item.status)) return false
      if (query && !item.fileName.toLowerCase().includes(query) && !(item.label?.toLowerCase().includes(query))) return false
      return true
    })
  }, [items, search, statuses])

  const grouped = group === 'status'
  const groups = useMemo<QueueGroup[]>(() => {
    if (!grouped) return []
    return STATUS_ORDER
      .filter((status) => filtered.some((item) => item.status === status))
      .map((status) => ({ key: status, label: QUEUE_STATUS_LABELS[status], items: filtered.filter((item) => item.status === status) }))
  }, [grouped, filtered])

  const total = filtered.length
  const safePage = Math.max(1, Math.min(page, Math.max(1, Math.ceil(total / pageSize))))
  const start = (safePage - 1) * pageSize
  const pageItems = useMemo(() => filtered.slice(start, start + pageSize), [filtered, start, pageSize])

  return {
    search,
    setSearch,
    group,
    setGroup,
    statuses,
    setStatuses,
    pageSize,
    setPageSize,
    page: safePage,
    setPage,
    total,
    grouped,
    groups,
    pageItems,
    start,
    statusFacets,
    activeFilterCount: statuses.length,
    clearFilters: () => setStatuses([])
  }
}
