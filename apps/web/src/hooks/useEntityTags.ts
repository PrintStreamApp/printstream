/** Shared tag cache. The core WebSocket listener invalidates ['tags'] on workspace changes. */
import { useCallback, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { LIBRARY_MANAGE_PERMISSION, LIBRARY_VIEW_PERMISSION, PRINTERS_MANAGE_PERMISSION, PRINTERS_VIEW_PERMISSION, SETTINGS_MANAGE_PERMISSION, tagSnapshotSchema, tagSearchText, compareTags, type TagEntityKind, type TagSnapshot } from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { useAuthBootstrapQuery } from '../lib/authQuery'
import { readCurrentWorkspaceScopeKey } from '../lib/workspaceScope'

const EMPTY: TagSnapshot = { tags: [], assignments: {} }
const EMPTY_IDS: string[] = []

/** Read only the entity kind the caller can view; never fetch tags in the public editor. */
export function useEntityTags(kind: TagEntityKind) {
  const auth = useAuthBootstrapQuery()
  const scope = readCurrentWorkspaceScopeKey()
  const viewPermission = kind === 'printer' ? PRINTERS_VIEW_PERMISSION : LIBRARY_VIEW_PERMISSION
  const editPermission = kind === 'printer' ? PRINTERS_MANAGE_PERMISSION : LIBRARY_MANAGE_PERMISSION
  const can = (permission: typeof viewPermission | typeof editPermission | typeof SETTINGS_MANAGE_PERMISSION) =>
    auth.isSuccess && Boolean(auth.data.workspace) && (!auth.data.authEnabled || auth.data.permissions.includes(permission))
  const query = useQuery({
    queryKey: ['tags', scope, kind],
    queryFn: async ({ signal }) => tagSnapshotSchema.parse(await apiFetch(`/api/tags/${kind}`, { signal })),
    staleTime: Infinity,
    enabled: can(viewPermission)
  })
  const data = query.data ?? EMPTY
  const tags = useMemo(() => [...data.tags].sort(compareTags), [data.tags])
  const byId = useMemo(() => new Map(data.tags.map((tag) => [tag.id, tag])), [data.tags])
  const assignedIds = useCallback((id: string) => data.assignments[id] ?? EMPTY_IDS, [data.assignments])
  const assignedTags = useCallback((id: string) => assignedIds(id).flatMap((tagId) => {
    const tag = byId.get(tagId)
    return tag ? [tag] : []
  }).sort(compareTags), [assignedIds, byId])
  const searchText = useCallback((id: string) => tagSearchText(assignedTags(id)), [assignedTags])
  return { ...query, tags, assignedIds, assignedTags, searchText, canAssign: can(editPermission), canManage: can(SETTINGS_MANAGE_PERMISSION) }
}
