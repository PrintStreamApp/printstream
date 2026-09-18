import { TagColorPicker } from './TagColorPicker'
/** Edits the current entity kind catalog; tag names and groups are freeform. */
import { suggestTagColor } from '../../lib/tagColors'
import { useState } from 'react'
import { Autocomplete, FormControl, FormLabel, Input } from '@mui/joy'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { extractErrorMessage, type TagEntityKind, type WorkspaceTag } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { FormDialog } from '../FormDialog'

export function TagEditDialog({ kind, tag, groups, existingColors, onClose }: {
  kind: TagEntityKind
  tag?: WorkspaceTag
  groups: string[]
  existingColors: string[]
  onClose: () => void
}) {
  const [name, setName] = useState(tag?.name ?? '')
  const [color, setColor] = useState(() => tag?.color ?? suggestTagColor(existingColors))
  const [group, setGroup] = useState(tag?.group ?? '')
  const client = useQueryClient()
  const save = useMutation({
    mutationFn: () => apiFetch(`/api/tags/${kind}${tag ? `/${tag.id}` : ''}`, {
      method: tag ? 'PUT' : 'POST',
      body: { name, color, group }
    }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['tags'] })
      onClose()
    }
  })

  return (
    <FormDialog
      title={tag ? 'Edit tag' : 'Create tag'}
      description={tag ? 'Changes apply everywhere this tag is used.' : undefined}
      onClose={onClose}
      onSubmit={() => save.mutate()}
      submitLabel="Save"
      submitDisabled={!name.trim() || !/^#[0-9a-f]{6}$/i.test(color)}
      busy={save.isPending}
      error={save.isError ? extractErrorMessage(save.error) : undefined}
    >
      <FormControl>
        <FormLabel>Name</FormLabel>
        <Input value={name} onChange={(event) => setName(event.target.value)} slotProps={{ input: { maxLength: 80 } }} />
      </FormControl>
      <TagColorPicker color={color} existingColors={existingColors} onChange={setColor} />
      <FormControl>
        <FormLabel>Group (optional)</FormLabel>
        <Autocomplete freeSolo options={groups} inputValue={group} onInputChange={(_event, value) => setGroup(value)} />
      </FormControl>
    </FormDialog>
  )
}
