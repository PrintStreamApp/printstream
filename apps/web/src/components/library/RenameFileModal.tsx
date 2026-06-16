/**
 * Rename-file dialog: edits only a library file's base name, keeping its
 * extension (and the sliced/printable classification that hangs off it) fixed.
 * Self-contained and props-only — performs its own `apiFetch` PATCH and reports
 * success via `onSaved`.
 */
import { useRef, useState } from 'react'
import { Box, Button, FormControl, FormLabel, Input, ModalDialog, Stack, Typography } from '@mui/joy'
import type { LibraryFile } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { splitLibraryFileNameForRename } from '../../lib/libraryDisplay'
import { BackAwareModal as Modal } from '../BackAwareModal'

export function RenameFileModal({
  file,
  onClose,
  onSaved
}: {
  file: LibraryFile
  onClose: () => void
  onSaved: () => void
}) {
  // The extension is fixed: renaming must never change a file's type (and the
  // sliced/printable classification that hangs off it), so only the base name is
  // editable — the extension renders read-only after the input, like the save dialogs.
  const { baseName: initialBaseName, extension } = splitLibraryFileNameForRename(file.name)
  const [baseName, setBaseName] = useState(initialBaseName)
  const hasSelectedEditableNameRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const nextName = `${baseName.trim()}${extension}`
  const canSubmit = baseName.trim().length > 0 && nextName !== file.name
  const submit = async () => {
    setSubmitting(true)
    setError(null)
    try {
      await apiFetch(`/api/library/${file.id}`, { method: 'PATCH', body: { name: nextName } })
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
  const handleNameFocus = (event: React.FocusEvent<HTMLInputElement>) => {
    if (hasSelectedEditableNameRef.current) return
    hasSelectedEditableNameRef.current = true
    event.target.select()
  }
  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 480, width: '100%' }}>
        <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Typography level="h4">Rename file</Typography>
          <FormControl>
            <FormLabel>Name</FormLabel>
            <Input
              value={baseName}
              autoFocus
              onFocus={handleNameFocus}
              onChange={(event) => setBaseName(event.target.value)}
              endDecorator={extension ? (
                <Typography level="body-sm" textColor="text.tertiary" sx={{ userSelect: 'none' }}>
                  {extension}
                </Typography>
              ) : undefined}
            />
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
