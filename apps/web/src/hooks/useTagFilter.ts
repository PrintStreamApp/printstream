/** Persisted tag facet, shared by directories and embedded pickers. */
import { useCallback, useEffect } from 'react'
import { matchesTagFilter, type TagEntityKind } from '@printstream/shared'
import { usePersistentState } from './usePersistentState'
import { useEntityTags } from './useEntityTags'
import { readCurrentWorkspaceScopeKey } from '../lib/workspaceScope'

const EMPTY: string[] = []
function parseIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

export function useTagFilter(kind: TagEntityKind, storageKey: string) {
  const tags = useEntityTags(kind)
  const scope = readCurrentWorkspaceScopeKey()
  const [value, onChange] = usePersistentState(`${storageKey}.tags.${scope}`, EMPTY, parseIds)
  useEffect(() => {
    if (!tags.isSuccess) return
    const known = new Set(tags.tags.map((tag) => tag.id))
    onChange((current) => {
      const next = current.filter((id) => known.has(id))
      return next.length === current.length ? current : next
    })
  }, [tags.isSuccess, tags.tags, onChange])
  const { assignedIds } = tags
  const matches = useCallback((id: string) => matchesTagFilter(assignedIds(id), value), [assignedIds, value])
  const clear = useCallback(() => onChange([]), [onChange])
  return { ...tags, value, onChange, matches, clear }
}
export type TagFilter = ReturnType<typeof useTagFilter>
