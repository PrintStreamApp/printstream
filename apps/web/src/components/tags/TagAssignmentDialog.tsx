/**
 * Incremental bulk editor. Only explicitly changed tags are written, so mixed assignments and
 * concurrent unrelated tag edits survive. The owner mounts this outside its closing menu.
 */
import { memo, useCallback, useState } from 'react'
import { Button, Checkbox, IconButton, Input, Stack, Typography } from '@mui/joy'
import EditIcon from '@mui/icons-material/Edit'
import DeleteIcon from '@mui/icons-material/DeleteOutlineRounded'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { extractErrorMessage, type TagEntityKind, type WorkspaceTag } from '@printstream/shared'
import { useEntityTags } from '../../hooks/useEntityTags'
import { apiFetch } from '../../lib/apiClient'
import { FormDialog } from '../FormDialog'
import { usePromptDialog } from '../PromptDialogProvider'
import { ListSkeleton } from '../ListSkeleton'
import CircleIcon from '@mui/icons-material/Circle'
import { TagEditDialog } from './TagEditDialog'

export const TagAssignmentDialog = memo(function TagAssignmentDialog({ kind, ids, onClose }: {
  kind: TagEntityKind; ids: string[]; onClose: () => void
}) {
  const tags = useEntityTags(kind)
  const client = useQueryClient()
  const { confirm } = usePromptDialog()
  const [changes, setChanges] = useState<Record<string, boolean>>({})
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<WorkspaceTag | 'new' | null>(null)
  const closeEdit = useCallback(() => setEditing(null), [])
  const save = useMutation({
    mutationFn: () => apiFetch(`/api/tags/${kind}/assign`, { method: 'POST', body: { entityIds: ids, add: Object.keys(changes).filter((id) => changes[id]), remove: Object.keys(changes).filter((id) => !changes[id]) } }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['tags'] }); onClose() }
  })
  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/tags/${kind}/${id}`, { method: 'DELETE' }),
    onSuccess: async (_data, id) => {
      setChanges((current) => { const next = { ...current }; delete next[id]; return next })
      await client.invalidateQueries({ queryKey: ['tags'] })
    }
  })
  async function deleteTag(tag: WorkspaceTag) {
    if (await confirm({ title: `Delete tag "${tag.name}"?`, description: 'This removes the tag from every item using it in this catalog.', confirmLabel: 'Delete', color: 'danger' })) remove.mutate(tag.id)
  }
  const error = save.error ?? remove.error ?? tags.error
  const visible = tags.tags.filter((tag) => `${tag.name} ${tag.group}`.toLowerCase().includes(search.toLowerCase()))
  return <>
    <FormDialog title={`Assign tags (${ids.length} ${ids.length === 1 ? 'item' : 'items'})`} description="A mixed checkbox means only some selected items have that tag. Only tags you change are updated." onClose={onClose} onSubmit={() => save.mutate()} submitLabel="Apply" busy={save.isPending || remove.isPending} submitDisabled={!tags.canAssign || tags.isPending || Boolean(tags.error) || Object.keys(changes).length === 0} error={error ? extractErrorMessage(error) : undefined}>
      <Input placeholder="Search tags or groups" value={search} onChange={(event) => setSearch(event.target.value)} slotProps={{ input: { 'aria-label': 'Search tags or groups' } }} />
      {tags.isPending && <ListSkeleton rows={3} />}
      {visible.map((tag, index) => {
        const count = ids.filter((id) => tags.assignedIds(id).includes(tag.id)).length
        const changed = Object.hasOwn(changes, tag.id)
        const checked = changed ? changes[tag.id] : count === ids.length
        return <Stack key={tag.id} spacing={1}>
          {(index === 0 || visible[index - 1]?.group !== tag.group) && <Typography level="title-sm" sx={{ overflowWrap: 'anywhere' }}>{tag.group || 'Ungrouped'}</Typography>}
          <Stack direction="row" spacing={1} alignItems="center">
            <CircleIcon style={{ color: tag.color, fontSize: 12 }} />
            <Checkbox sx={{ minWidth: 0, flex: 1, overflowWrap: 'anywhere' }} label={tag.name} checked={checked} indeterminate={!changed && count > 0 && count < ids.length} disabled={!tags.canAssign} onChange={(event) => setChanges((current) => ({ ...current, [tag.id]: event.target.checked }))} />
            {tags.canManage && <>
              <IconButton size="sm" aria-label={`Edit ${tag.name}`} onClick={() => setEditing(tag)}><EditIcon /></IconButton>
              <IconButton size="sm" color="danger" aria-label={`Delete ${tag.name}`} onClick={() => void deleteTag(tag)}><DeleteIcon /></IconButton>
            </>}
          </Stack>
        </Stack>
      })}
      {!tags.isPending && !visible.length && <Typography level="body-sm">No tags found.</Typography>}
      {tags.canAssign && <Button size="sm" variant="outlined" onClick={() => setEditing('new')}>Create tag</Button>}
    </FormDialog>
    {editing && <TagEditDialog existingColors={tags.tags.map((tag) => tag.color)} kind={kind} tag={editing === 'new' ? undefined : editing} groups={[...new Set(tags.tags.map((tag) => tag.group).filter(Boolean))]} onClose={closeEdit} />}
  </>
})
