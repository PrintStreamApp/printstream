/**
 * Library folder CRUD dialogs: create, rename, and move a folder. Each is a
 * self-contained, props-only modal that performs its own `apiFetch` mutation and
 * calls back on success — no shared page state flows through them. `MoveFolderModal`
 * owns `flattenFoldersForSelect`, the parent-folder option builder it alone uses.
 */
import { useMemo, useRef, useState } from 'react'
import { Box, Button, FormControl, FormLabel, Input, ModalDialog, Option, Select, Stack, Typography } from '@mui/joy'
import CreateNewFolderRoundedIcon from '@mui/icons-material/CreateNewFolderRounded'
import DriveFileMoveRoundedIcon from '@mui/icons-material/DriveFileMoveRounded'
import type { LibraryFolder } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { BackAwareModal as Modal } from '../BackAwareModal'

/**
 * Flatten the folder tree into an indented option list for a parent-folder
 * `Select`. The root is always first; `excludeSubtreeOf` drops a folder (and its
 * descendants) so a folder can't be reparented into itself.
 */
function flattenFoldersForSelect(
  folders: LibraryFolder[],
  rootLabel: string,
  excludeSubtreeOf?: string
): Array<{ id: string | null; label: string }> {
  const childrenOf = new Map<string | null, LibraryFolder[]>()
  for (const folder of folders) {
    const list = childrenOf.get(folder.parentId) ?? []
    list.push(folder)
    childrenOf.set(folder.parentId, list)
  }
  const out: Array<{ id: string | null; label: string }> = [{ id: null, label: rootLabel }]
  const walk = (parentId: string | null, prefix: string) => {
    const list = (childrenOf.get(parentId) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))
    for (const folder of list) {
      if (folder.id === excludeSubtreeOf) continue
      out.push({ id: folder.id, label: `${prefix}${folder.name}` })
      walk(folder.id, `${prefix}${folder.name} / `)
    }
  }
  walk(null, '')
  return out
}

export function CreateFolderModal({
  parentId,
  bridgeId,
  onClose,
  onCreated
}: {
  parentId: string | null
  bridgeId: string | null
  onClose: () => void
  onCreated: () => void
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const canSubmit = name.trim().length > 0
  const submit = async () => {
    setSubmitting(true)
    setError(null)
    try {
      await apiFetch('/api/library/folders', { method: 'POST', body: { name, parentId, bridgeId } })
      onCreated()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit || submitting) return
    void submit()
  }
  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 420, width: '100%' }}>
        <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Typography level="h4">New folder</Typography>
          <FormControl>
            <FormLabel>Name</FormLabel>
            <Input value={name} autoFocus onChange={(event) => setName(event.target.value)} />
          </FormControl>
          {error && <Typography color="danger" level="body-sm">{error}</Typography>}
          <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
            <Button type="button" variant="plain" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={submitting} startDecorator={<CreateNewFolderRoundedIcon />} disabled={!canSubmit}>Create</Button>
          </Stack>
        </Box>
      </ModalDialog>
    </Modal>
  )
}

export function RenameFolderModal({
  folder,
  onClose,
  onSaved
}: {
  folder: LibraryFolder
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(folder.name)
  const hasSelectedNameRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const canSubmit = name.trim().length > 0 && name !== folder.name
  // Select the whole name on first focus (folders have no extension to protect),
  // matching the rename-file dialog's ready-to-overtype behavior.
  const handleNameFocus = (event: React.FocusEvent<HTMLInputElement>) => {
    if (hasSelectedNameRef.current) return
    hasSelectedNameRef.current = true
    event.target.select()
  }
  const submit = async () => {
    setSubmitting(true)
    setError(null)
    try {
      await apiFetch(`/api/library/folders/${folder.id}`, { method: 'PATCH', body: { name } })
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit || submitting) return
    void submit()
  }
  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 420, width: '100%' }}>
        <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Typography level="h4">Rename folder</Typography>
          <FormControl>
            <FormLabel>Name</FormLabel>
            <Input value={name} autoFocus onFocus={handleNameFocus} onChange={(event) => setName(event.target.value)} />
          </FormControl>
          {error && <Typography color="danger" level="body-sm">{error}</Typography>}
          <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
            <Button type="button" variant="plain" onClick={onClose}>Cancel</Button>
            <Button
              type="submit"
              loading={submitting}
              disabled={!canSubmit}
            >
              Save
            </Button>
          </Stack>
        </Box>
      </ModalDialog>
    </Modal>
  )
}

export function MoveFolderModal({
  folder,
  folders,
  bridgeId,
  bridgeName,
  onClose,
  onSaved
}: {
  folder: LibraryFolder
  folders: LibraryFolder[]
  bridgeId: string | null
  bridgeName: string | null
  onClose: () => void
  onSaved: () => void
}) {
  const rootLabel = bridgeName ?? 'Bridge root'
  const options = useMemo(() => flattenFoldersForSelect(folders, rootLabel, folder.id), [folder.id, folders, rootLabel])
  const [target, setTarget] = useState<string | null>(folder.parentId)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const submit = async () => {
    setSubmitting(true)
    setError(null)
    try {
      await apiFetch(`/api/library/folders/${folder.id}`, {
        method: 'PATCH',
        body: { parentId: target, bridgeId }
      })
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 480, width: '100%' }}>
        <Typography level="h4">Move folder</Typography>
        <Typography level="body-sm" textColor="text.tertiary">{folder.name}</Typography>
        <FormControl>
          <FormLabel>New parent</FormLabel>
          <Select
            value={target ?? '__root'}
            onChange={(_event, value) => setTarget(value === '__root' ? null : (value ?? null))}
          >
            {options.map((option) => (
              <Option key={option.id ?? '__root'} value={option.id ?? '__root'}>{option.label}</Option>
            ))}
          </Select>
        </FormControl>
        {error && <Typography color="danger" level="body-sm">{error}</Typography>}
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
          <Button variant="plain" onClick={onClose}>Cancel</Button>
          <Button loading={submitting} startDecorator={<DriveFileMoveRoundedIcon />} onClick={submit}>Move</Button>
        </Stack>
      </ModalDialog>
    </Modal>
  )
}
