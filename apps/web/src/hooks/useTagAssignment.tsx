/** Keep the tag dialog mounted independently of menus, with stable live-view callbacks. */
import { useCallback, useState } from 'react'
import type { TagEntityKind } from '@printstream/shared'
import { TagAssignmentDialog } from '../components/tags/TagAssignmentDialog'

export function useTagAssignment(kind: TagEntityKind) {
  const [ids, setIds] = useState<string[] | null>(null)
  const close = useCallback(() => setIds(null), [])
  return { openTags: setIds, tagDialog: ids ? <TagAssignmentDialog kind={kind} ids={ids} onClose={close} /> : null }
}
