/** History facets use archived vocabulary, including deleted tags and earlier name/color versions. */
import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { JOBS_VIEW_PERMISSION, jobTagCatalogSchema, type JobTag, type TagEntityKind } from '@printstream/shared'
import { usePersistentState } from './usePersistentState'
import { useAuthBootstrapQuery } from '../lib/authQuery'
import { apiFetch } from '../lib/apiClient'
import { readCurrentWorkspaceScopeKey } from '../lib/workspaceScope'

const EMPTY: JobTag[] = []
const EMPTY_IDS: string[] = []
function parseIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

/** Prune only after a successful archive read; live catalog edits cannot clear historical selections. */
function useHistoryTagFilter(kind: TagEntityKind, scope: string, catalog: JobTag[], ready: boolean) {
  const tags = useMemo(() => catalog.filter((tag) => tag.entityKind === kind), [catalog, kind])
  const [value, onChange] = usePersistentState(`jobs.history.${kind}.tags.${scope}`, EMPTY_IDS, parseIds)
  useEffect(() => {
    if (!ready) return
    const known = new Set(tags.map((tag) => tag.id))
    onChange((current) => {
      const next = current.filter((id) => known.has(id))
      return next.length === current.length ? current : next
    })
  }, [ready, tags, onChange])
  return { tags, value, onChange, clear: () => onChange([]) }
}

export function useJobHistoryTagFilters() {
  const scope = readCurrentWorkspaceScopeKey()
  const auth = useAuthBootstrapQuery()
  const query = useQuery({
    // Existing job completion/deletion/reconnect invalidation owns this prefix.
    queryKey: ['job-history', 'tag-catalog', scope],
    queryFn: async ({ signal }) => jobTagCatalogSchema.parse(await apiFetch('/api/jobs/history/tags', { signal })),
    enabled: auth.isSuccess && Boolean(auth.data.workspace)
      && (!auth.data.authEnabled || auth.data.permissions.includes(JOBS_VIEW_PERMISSION))
  })
  const tags = query.data?.tags ?? EMPTY
  const printer = useHistoryTagFilter('printer', scope, tags, query.isSuccess)
  const file = useHistoryTagFilter('file', scope, tags, query.isSuccess)
  const spool = useHistoryTagFilter('spool', scope, tags, query.isSuccess)
  const filters = [
    { label: 'Printer tags', filter: { ...printer, isPending: query.isPending, isError: query.isError } },
    { label: 'File tags', filter: { ...file, isPending: query.isPending, isError: query.isError } },
    { label: 'Spool tags', filter: { ...spool, isPending: query.isPending, isError: query.isError } }
  ]
  return {
    filters,
    ids: filters.flatMap(({ filter }) => filter.value),
    activeCount: filters.filter(({ filter }) => filter.value.length > 0).length,
    clear: () => filters.forEach(({ filter }) => filter.clear())
  }
}
