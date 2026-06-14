/**
 * Log viewer with client-side filtering, sorting, and pagination.
 * Polls `/api/logs` every 5s and lets the user toggle visible log levels
 * directly from the toolbar.
 */
import React, { useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { AuditLogEntry, LogsResponse, LogEntry, LogLevel } from '@printstream/shared'
import { Box, Button, Chip, FormControl, FormLabel, Input, Option, Select, Sheet, Stack, Table, Typography } from '@mui/joy'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'
import DeleteSweepRoundedIcon from '@mui/icons-material/DeleteSweepRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PaginatedSection } from '../components/PaginationFooter'
import { usePromptDialog } from '../components/PromptDialogProvider'
import { SortableTableHeader } from '../components/SortableTableHeader'
import { apiFetch } from '../lib/apiClient'
import { formatDateTime } from '../lib/time'

type LogSortKey = 'timestamp' | 'kind' | 'actor' | 'message'
type SortDirection = 'asc' | 'desc'
type LogKind = LogEntry['kind']

const DEFAULT_VISIBLE_SYSTEM_LEVELS: ReadonlyArray<LogLevel> = ['error', 'warn', 'info', 'debug']
const DEFAULT_VISIBLE_AUDIT_LEVELS: ReadonlyArray<LogLevel> = ['error', 'warn', 'info']
const PAGE_SIZE_OPTIONS = [25, 50, 100] as const
const EMPTY_ENTRIES: LogEntry[] = []

function formatSelectedSummary(values: ReadonlyArray<string>, allCount: number, allLabel: string): string {
  if (values.length === 0) return 'None'
  if (values.length === allCount) return allLabel
  if (values.length === 1) return values[0] ?? '1 selected'
  return `${values.length} selected`
}

export function LogsView() {
  return <LogsPanel />
}

export function LogsPanel({ embedded = false, surface = 'tenant' }: { embedded?: boolean; surface?: 'platform' | 'tenant' }) {
  const queryClient = useQueryClient()
  const { confirm } = usePromptDialog()
  const kindOptions: LogKind[] = surface === 'platform' ? ['audit'] : ['audit', 'system']
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [visibleKinds, setVisibleKinds] = useState<LogKind[]>(() => surface === 'platform' ? ['audit'] : ['audit', 'system'])
  const [visibleSystemLevels, setVisibleSystemLevels] = useState<LogLevel[]>(() => [...DEFAULT_VISIBLE_SYSTEM_LEVELS])
  const [visibleAuditLevels, setVisibleAuditLevels] = useState<LogLevel[]>(() => [...DEFAULT_VISIBLE_AUDIT_LEVELS])
  const [sortKey, setSortKey] = useState<LogSortKey>('timestamp')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE_OPTIONS[0])
  const logsQuery = useQuery({
    queryKey: ['logs', surface],
    queryFn: ({ signal }) => apiFetch<LogsResponse>('/api/logs?limit=1000', { signal }),
    refetchInterval: 5_000
  })
  const clear = useMutation({
    mutationFn: () => apiFetch('/api/logs', { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['logs'] })
  })

  const entries = logsQuery.data?.entries ?? EMPTY_ENTRIES
  const filteredEntries = useMemo(() => {
    const activeKinds = new Set(visibleKinds)
    const activeSystemLevels = new Set(visibleSystemLevels)
    const activeAuditLevels = new Set(visibleAuditLevels)
    const normalizedQuery = deferredSearch.trim().toLowerCase()
    return entries
      .filter((entry) => activeKinds.has(entry.kind))
      .filter((entry) => entry.kind === 'audit' ? activeAuditLevels.has(entry.level) : activeSystemLevels.has(entry.level))
      .filter((entry) => {
        if (!normalizedQuery) return true
        return entry.kind === 'audit'
          ? entry.summary.toLowerCase().includes(normalizedQuery)
            || entry.resource.toLowerCase().includes(normalizedQuery)
            || entry.action.toLowerCase().includes(normalizedQuery)
            || entry.level.toLowerCase().includes(normalizedQuery)
            || (entry.actorLabel ?? '').toLowerCase().includes(normalizedQuery)
            || formatDateTime(entry.timestamp).toLowerCase().includes(normalizedQuery)
          : entry.message.toLowerCase().includes(normalizedQuery)
            || entry.level.toLowerCase().includes(normalizedQuery)
            || formatDateTime(entry.timestamp).toLowerCase().includes(normalizedQuery)
      })
      .sort((left, right) => compareEntries(left, right, sortKey, sortDirection))
  }, [deferredSearch, entries, sortDirection, sortKey, visibleAuditLevels, visibleKinds, visibleSystemLevels])
  const pageCount = Math.max(1, Math.ceil(filteredEntries.length / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  const visibleEntries = useMemo(() => {
    const start = safePage * pageSize
    return filteredEntries.slice(start, start + pageSize)
  }, [filteredEntries, pageSize, safePage])

  useEffect(() => {
    setPage((current) => Math.min(current, Math.max(0, Math.ceil(filteredEntries.length / pageSize) - 1)))
  }, [filteredEntries.length, pageSize])

  return (
    <Stack spacing={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
        <Typography level={embedded ? 'title-md' : 'h3'}>{surface === 'platform' ? 'Platform logs' : 'Tenant logs'}</Typography>
        <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
          <Button size="sm" variant="plain" startDecorator={<RefreshRoundedIcon />} onClick={() => logsQuery.refetch()}>Refresh</Button>
          <Button
            size="sm"
            variant="soft"
            color="danger"
            startDecorator={<DeleteSweepRoundedIcon />}
            loading={clear.isPending}
            onClick={async () => {
              const confirmed = await confirm({
                title: surface === 'platform' ? 'Clear platform logs?' : 'Clear tenant logs?',
                description: surface === 'platform' ? 'Clear all platform logs?' : 'Clear all tenant logs?',
                confirmLabel: 'Clear logs',
                color: 'danger'
              })
              if (!confirmed) return
              clear.mutate()
            }}
          >Clear</Button>
        </Stack>
      </Stack>

      <Stack spacing={1.25}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25}>
          <FormControl sx={{ flex: 1 }}>
            <Input
              aria-label="Filter logs"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search actor, action, message, or timestamp"
            />
          </FormControl>
          <FormControl sx={{ minWidth: { xs: '100%', md: 190 } }}>
            <Select
              aria-label="Rows per page"
              value={pageSize}
              onChange={(_event, value) => value && setPageSize(value)}
              renderValue={(option) => `Rows: ${option?.value ?? pageSize} per page`}
            >
              {PAGE_SIZE_OPTIONS.map((value) => (
                <Option key={value} value={value}>{value} rows per page</Option>
              ))}
            </Select>
          </FormControl>
        </Stack>

        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25}>
          <FormControl sx={{ minWidth: { xs: '100%', md: 220 } }}>
            <FormLabel>Log kinds</FormLabel>
              <Select
                multiple
                value={visibleKinds}
                onChange={(_event, value) => {
                  setPage(0)
                  setVisibleKinds(value ?? [])
                }}
                renderValue={() => (
                  <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
                    <Typography level="body-sm" textColor="text.tertiary" noWrap>Kinds:</Typography>
                    <Chip size="sm" variant="soft">{formatSelectedSummary(visibleKinds, kindOptions.length, 'All')}</Chip>
                  </Stack>
                )}
                slotProps={{ listbox: { sx: { maxHeight: 280 } } }}
              >
                {kindOptions.map((kind) => (
                  <Option key={kind} value={kind}>{kind}</Option>
                ))}
              </Select>
          </FormControl>

          {visibleKinds.includes('audit') && (
            <FormControl sx={{ minWidth: { xs: '100%', md: 240 } }}>
              <FormLabel>Audit levels</FormLabel>
              <Select
                multiple
                value={visibleAuditLevels}
                onChange={(_event, value) => {
                  setPage(0)
                  setVisibleAuditLevels(value ?? [])
                }}
                renderValue={() => (
                  <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
                    <Typography level="body-sm" textColor="text.tertiary" noWrap>Audit:</Typography>
                    <Chip size="sm" variant="soft">{formatSelectedSummary(visibleAuditLevels, 4, 'All')}</Chip>
                  </Stack>
                )}
                slotProps={{ listbox: { sx: { maxHeight: 280 } } }}
              >
                {(['error', 'warn', 'info', 'debug'] satisfies LogLevel[]).map((level) => (
                  <Option key={level} value={level}>{level}</Option>
                ))}
              </Select>
            </FormControl>
          )}

          {visibleKinds.includes('system') && (
            <FormControl sx={{ minWidth: { xs: '100%', md: 240 } }}>
              <FormLabel>System levels</FormLabel>
              <Select
                multiple
                value={visibleSystemLevels}
                onChange={(_event, value) => {
                  setPage(0)
                  setVisibleSystemLevels(value ?? [])
                }}
                renderValue={() => (
                  <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
                    <Typography level="body-sm" textColor="text.tertiary" noWrap>System:</Typography>
                    <Chip size="sm" variant="soft">{formatSelectedSummary(visibleSystemLevels, 4, 'All')}</Chip>
                  </Stack>
                )}
                slotProps={{ listbox: { sx: { maxHeight: 280 } } }}
              >
                {(['error', 'warn', 'info', 'debug'] satisfies LogLevel[]).map((level) => (
                  <Option key={level} value={level}>{level}</Option>
                ))}
              </Select>
            </FormControl>
          )}
        </Stack>
      </Stack>

      {entries.length === 0 && (
        <Sheet
          variant="outlined"
          sx={{
            borderRadius: 'md',
            overflow: 'hidden',
            fontFamily: 'monospace',
            fontSize: 'xs'
          }}
        >
          <Typography level="body-sm" textColor="text.tertiary" sx={{ p: 1.5 }}>
            {surface === 'platform' ? 'No platform log entries yet.' : 'No tenant log entries yet.'}
          </Typography>
        </Sheet>
      )}
      {entries.length > 0 && filteredEntries.length === 0 && (
        <Sheet
          variant="outlined"
          sx={{
            borderRadius: 'md',
            overflow: 'hidden',
            fontFamily: 'monospace',
            fontSize: 'xs'
          }}
        >
          <Typography level="body-sm" textColor="text.tertiary" sx={{ p: 1.5 }}>
            No log entries match the current filters.
          </Typography>
        </Sheet>
      )}
      {filteredEntries.length > 0 && (
        <PaginatedSection
          showingLabel={`Showing ${safePage * pageSize + 1}-${Math.min((safePage + 1) * pageSize, filteredEntries.length)} of ${filteredEntries.length}`}
          previousDisabled={safePage === 0}
          nextDisabled={safePage >= pageCount - 1}
          onPrevious={() => setPage((current) => Math.max(0, current - 1))}
          onNext={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
          spacing={1.5}
        >
          <Sheet
            variant="outlined"
            sx={{
              borderRadius: 'md',
              overflow: 'hidden',
              fontFamily: 'monospace',
              fontSize: 'xs'
            }}
          >
            <Box sx={{ display: { xs: 'block', sm: 'none' } }}>
              <Stack divider={<Box sx={{ borderTop: '1px solid var(--joy-palette-neutral-800)' }} />}>
                {visibleEntries.map((entry, index) => (
                  <Stack key={`${entry.kind}-${entry.timestamp}-${safePage}-${index}`} spacing={1} sx={{ p: 1.5 }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
                      <Typography level="body-xs" textColor="text.tertiary">
                        {formatDateTime(entry.timestamp)}
                      </Typography>
                      <Stack direction="row" spacing={0.5}>
                        <Chip size="sm" variant="soft" color={entry.kind === 'audit' ? 'primary' : 'neutral'}>{entry.kind}</Chip>
                        <Chip size="sm" variant="soft" color={levelColor(entry.level)}>{entry.level}</Chip>
                      </Stack>
                    </Stack>
                    {entry.kind === 'audit' ? (
                      <Stack spacing={0.35}>
                        <Typography level="body-xs">{entry.summary}</Typography>
                        <Typography level="body-xs" textColor="text.tertiary">
                          {renderAuditActor(entry)} · {entry.action} · {entry.resource} · status {entry.statusCode}
                        </Typography>
                      </Stack>
                    ) : (
                      <Typography level="body-xs" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {entry.message}
                      </Typography>
                    )}
                  </Stack>
                ))}
              </Stack>
            </Box>

            <Box sx={{ display: { xs: 'none', sm: 'block' }, overflowX: 'auto' }}>
              <Table borderAxis="xBetween" stripe="odd" size="sm" stickyHeader hoverRow>
                <thead>
                  <tr>
                    <th style={{ width: '220px' }}>
                      <SortableTableHeader
                        label="Time"
                        active={sortKey === 'timestamp'}
                        direction={sortDirection}
                        onClick={() => setSort('timestamp', sortKey, sortDirection, setSortKey, setSortDirection)}
                      />
                    </th>
                    <th style={{ width: '96px' }}>
                      <SortableTableHeader
                        label="Kind"
                        active={sortKey === 'kind'}
                        direction={sortDirection}
                        onClick={() => setSort('kind', sortKey, sortDirection, setSortKey, setSortDirection)}
                      />
                    </th>
                    <th style={{ width: '220px' }}>
                      <SortableTableHeader
                        label="Actor"
                        active={sortKey === 'actor'}
                        direction={sortDirection}
                        onClick={() => setSort('actor', sortKey, sortDirection, setSortKey, setSortDirection)}
                      />
                    </th>
                    <th>
                      <SortableTableHeader
                        label="Details"
                        active={sortKey === 'message'}
                        direction={sortDirection}
                        onClick={() => setSort('message', sortKey, sortDirection, setSortKey, setSortDirection)}
                      />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleEntries.map((entry, index) => (
                    <tr key={`${entry.kind}-${entry.timestamp}-${safePage}-${index}`}>
                      <td>
                        <Typography level="body-xs" textColor="text.tertiary">{formatDateTime(entry.timestamp)}</Typography>
                      </td>
                      <td>
                        <Stack direction="row" spacing={0.5}>
                          <Chip size="sm" variant="soft" color={entry.kind === 'audit' ? 'primary' : 'neutral'}>{entry.kind}</Chip>
                          <Chip size="sm" variant="soft" color={levelColor(entry.level)}>{entry.level}</Chip>
                        </Stack>
                      </td>
                      <td>
                        <Typography level="body-xs" textColor="text.tertiary">
                          {entry.kind === 'audit' ? renderAuditActor(entry) : 'system'}
                        </Typography>
                      </td>
                      <td>
                        {entry.kind === 'audit' ? (
                          <Stack spacing={0.35}>
                            <Typography level="body-xs">{entry.summary}</Typography>
                            <Typography level="body-xs" textColor="text.tertiary">
                              {entry.action} · {entry.resource} · status {entry.statusCode}
                            </Typography>
                          </Stack>
                        ) : (
                          <Typography level="body-xs" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {entry.message}
                          </Typography>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Box>
          </Sheet>
        </PaginatedSection>
      )}
    </Stack>
  )
}

function setSort(
  nextKey: LogSortKey,
  currentKey: LogSortKey,
  currentDirection: SortDirection,
  setSortKey: (value: LogSortKey) => void,
  setSortDirection: (value: SortDirection) => void
): void {
  if (nextKey === currentKey) {
    setSortDirection(currentDirection === 'asc' ? 'desc' : 'asc')
    return
  }
  setSortKey(nextKey)
  setSortDirection(nextKey === 'timestamp' ? 'desc' : 'asc')
}

function compareEntries(left: LogEntry, right: LogEntry, sortKey: LogSortKey, sortDirection: SortDirection): number {
  const direction = sortDirection === 'asc' ? 1 : -1
  switch (sortKey) {
    case 'kind':
      return left.kind.localeCompare(right.kind) * direction
    case 'actor':
      return readEntryActor(left).localeCompare(readEntryActor(right)) * direction
    case 'message':
      return readEntryMessage(left).localeCompare(readEntryMessage(right)) * direction
    case 'timestamp':
    default:
      return left.timestamp.localeCompare(right.timestamp) * direction
  }
}

function levelColor(level: LogLevel): 'neutral' | 'warning' | 'danger' | 'primary' {
  switch (level) {
    case 'error': return 'danger'
    case 'warn': return 'warning'
    case 'debug': return 'neutral'
    default: return 'primary'
  }
}

function renderAuditActor(entry: AuditLogEntry): string {
  return entry.actorLabel
    ?? entry.actorUserId
    ?? entry.actorServiceAccountId
    ?? entry.actorType
}

function readEntryActor(entry: LogEntry): string {
  return entry.kind === 'audit' ? renderAuditActor(entry) : 'system'
}

function readEntryMessage(entry: LogEntry): string {
  return entry.kind === 'audit'
    ? `${entry.summary} ${entry.action} ${entry.resource} ${entry.actorLabel ?? ''} ${entry.actorUserId ?? ''} ${entry.actorServiceAccountId ?? ''}`
    : entry.message
}
