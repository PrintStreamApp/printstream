/** Persisted tag facet, shared by directories and embedded pickers. */
import { useCallback, useEffect } from 'react'
import { matchesTagFilter, type TagEntityKind } from '@printstream/shared'
import { usePersistentState } from './usePersistentState'
import { useEntityTags } from './useEntityTags'
import { readCurrentWorkspaceScopeKey } from '../lib/workspaceScope'
import { tagFilterKeys } from '../lib/storageKeys'

const EMPTY: string[] = []
function parseIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

/**
 * A tag filter's selection, remembered per surface and per workspace route scope.
 *
 * @param area which surface this is (`library`, `printers.overview`); part of the declared key.
 * @param legacyArea the fragment the surface's key was built from before keys were declared, when
 *   it differs from `area`, so a saved selection carries over.
 */
export function useTagFilter(kind: TagEntityKind, area: string, legacyArea: string = area) {
  const tags = useEntityTags(kind)
  const scope = readCurrentWorkspaceScopeKey()
  const [value, onChange] = usePersistentState(
    tagFilterKeys.at(`${area}.${scope}`),
    EMPTY,
    parseIds,
    [`${legacyArea}.tags.${scope}`]
  )
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
