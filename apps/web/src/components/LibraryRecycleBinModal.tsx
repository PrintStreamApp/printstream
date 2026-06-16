/**
 * Library recycle bin dialog: lists soft-deleted files with restore and
 * permanent-delete actions, plus an "Empty recycle bin" action. Permanent
 * deletion reuses the background delete-job pipeline, so progress keeps
 * reporting after the dialog closes. Entries also age out automatically on
 * the server after the recycle retention window.
 */
import { useMemo } from 'react'
import { Box, Button, Chip, DialogActions, Stack, Typography } from '@mui/joy'
import DeleteForeverRoundedIcon from '@mui/icons-material/DeleteForeverRounded'
import RestoreFromTrashRoundedIcon from '@mui/icons-material/RestoreFromTrashRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { LibraryRecycleBinEntry, LibraryRecycleBinResponse } from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { formatLibraryFileKindLabel, formatLibraryFileName } from '../lib/libraryDisplay'
import { invalidateLibraryQueries } from '../lib/libraryQueryInvalidation'
import { formatDateTime } from '../lib/time'
import { toast } from '../lib/toast'
import { BackAwareModal as Modal } from './BackAwareModal'
import { EmptyState } from './EmptyState'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'
import { usePromptDialog } from './PromptDialogProvider'

export function LibraryRecycleBinModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const { confirm } = usePromptDialog()
  const binQuery = useQuery({
    queryKey: ['library-recycle-bin'],
    queryFn: ({ signal }) => apiFetch<LibraryRecycleBinResponse>('/api/library/recycle-bin', { signal })
  })
  const files = useMemo(() => binQuery.data?.files ?? [], [binQuery.data])

  const invalidate = async () => {
    await invalidateLibraryQueries(queryClient)
    await queryClient.invalidateQueries({ queryKey: ['library-recycle-bin'] })
  }

  const restore = useMutation({
    mutationFn: (entry: LibraryRecycleBinEntry) =>
      apiFetch('/api/library/recycle-bin/restore', { method: 'POST', body: { fileIds: [entry.id] } }),
    onSuccess: (_response, entry) => {
      toast.success(`Restored "${formatLibraryFileName(entry.name)}"`)
      void invalidate()
    }
  })
  const deleteForever = useMutation({
    mutationFn: (entry: LibraryRecycleBinEntry) =>
      apiFetch('/api/library/delete-jobs', { method: 'POST', body: { fileIds: [entry.id] } }),
    onSuccess: () => {
      void invalidate()
      void queryClient.invalidateQueries({ queryKey: ['delete-operations'] })
    }
  })
  const emptyBin = useMutation({
    mutationFn: () => apiFetch('/api/library/recycle-bin', { method: 'DELETE' }),
    onSuccess: () => {
      void invalidate()
      void queryClient.invalidateQueries({ queryKey: ['delete-operations'] })
    }
  })

  const pending = restore.isPending || deleteForever.isPending || emptyBin.isPending

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ maxWidth: 560, width: '100%' }}>
        <Typography level="h4">Recycle bin</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          Deleted files can be restored from here. They are removed permanently when the bin is emptied or after the retention window expires.
        </Typography>
        <ScrollableDialogBody sx={{ mt: 1 }}>
          {binQuery.isLoading ? (
            <Typography level="body-sm" textColor="text.tertiary">Loading…</Typography>
          ) : files.length === 0 ? (
            <EmptyState
              icon={<RestoreFromTrashRoundedIcon />}
              title="The recycle bin is empty"
              description="Files you delete from the library will appear here."
            />
          ) : (
            <Stack spacing={0.75}>
              {files.map((entry) => (
                <Stack
                  key={entry.id}
                  direction="row"
                  spacing={1}
                  alignItems="center"
                  sx={{ p: 1, borderRadius: 'sm', bgcolor: 'background.level1' }}
                >
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
                      <Typography level="body-sm" noWrap sx={{ minWidth: 0 }}>
                        {formatLibraryFileName(entry.name)}
                      </Typography>
                      <Chip size="sm" variant="soft" color="neutral">
                        {formatLibraryFileKindLabel(entry.name, entry.kind)}
                      </Chip>
                    </Stack>
                    <Typography level="body-xs" textColor="text.tertiary">
                      Deleted {formatDateTime(entry.deletedAt)}
                    </Typography>
                  </Box>
                  <Button
                    size="sm"
                    variant="soft"
                    startDecorator={<RestoreFromTrashRoundedIcon />}
                    disabled={pending}
                    onClick={() => restore.mutate(entry)}
                  >
                    Restore
                  </Button>
                  <Button
                    size="sm"
                    variant="soft"
                    color="danger"
                    startDecorator={<DeleteForeverRoundedIcon />}
                    disabled={pending}
                    onClick={async () => {
                      const confirmed = await confirm({
                        title: 'Delete forever?',
                        description: `Permanently delete "${formatLibraryFileName(entry.name)}" and its version history? This cannot be undone.`,
                        confirmLabel: 'Delete forever',
                        color: 'danger'
                      })
                      if (confirmed) deleteForever.mutate(entry)
                    }}
                  >
                    Delete forever
                  </Button>
                </Stack>
              ))}
            </Stack>
          )}
        </ScrollableDialogBody>
        <DialogActions>
          <Button variant="plain" color="neutral" onClick={onClose}>Close</Button>
          <Button
            color="danger"
            startDecorator={<DeleteForeverRoundedIcon />}
            disabled={files.length === 0 || pending}
            loading={emptyBin.isPending}
            onClick={async () => {
              const confirmed = await confirm({
                title: 'Empty recycle bin?',
                description: `Permanently delete ${files.length} file${files.length === 1 ? '' : 's'} and their version history? This cannot be undone.`,
                confirmLabel: 'Empty recycle bin',
                color: 'danger'
              })
              if (confirmed) emptyBin.mutate()
            }}
          >
            Empty recycle bin
          </Button>
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
  )
}
