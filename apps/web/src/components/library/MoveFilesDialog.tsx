/**
 * Move-file(s) dialogs. `MoveFilesDialog` is the shared folder-browser modal that
 * PATCHes each file's `folderId`; `MoveFileModal` and `MoveFilesModal` are thin,
 * fixed-title wrappers for the single- and multi-file cases. All are props-only and
 * report success via `onSaved`.
 */
import { useState } from 'react'
import { Typography } from '@mui/joy'
import DriveFileMoveRoundedIcon from '@mui/icons-material/DriveFileMoveRounded'
import type { LibraryFile, LibraryFolder } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { formatLibraryFileName } from '../../lib/libraryDisplay'
import { LibraryDestinationDialog } from '../LibraryDestinationDialog'

export function MoveFileModal({
  file,
  folders,
  bridgeId,
  bridgeName,
  showRoot,
  onClose,
  onSaved
}: {
  file: LibraryFile
  folders: LibraryFolder[]
  bridgeId: string | null
  bridgeName: string | null
  showRoot: boolean
  onClose: () => void
  onSaved: () => void
}) {
  return (
    <MoveFilesDialog
      files={[file]}
      folders={folders}
      bridgeId={bridgeId}
      bridgeName={bridgeName}
      showRoot={showRoot}
      title="Move file"
      onClose={onClose}
      onSaved={onSaved}
    />
  )
}

export function MoveFilesDialog({
  files,
  folders,
  bridgeId,
  bridgeName,
  showRoot,
  title,
  onClose,
  onSaved
}: {
  files: LibraryFile[]
  folders: LibraryFolder[]
  bridgeId: string | null
  bridgeName: string | null
  showRoot: boolean
  title: string
  onClose: () => void
  onSaved: () => void
}) {
  const initialFolderId = files.every((entry) => entry.folderId === (files[0]?.folderId ?? null))
    ? (files[0]?.folderId ?? null)
    : null
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const submit = async (outputFolderId: string | null) => {
    if (!files.some((entry) => entry.folderId !== outputFolderId)) return
    setSubmitting(true)
    setError(null)
    try {
      await Promise.all(
        files
          .filter((entry) => entry.folderId !== outputFolderId)
          .map((entry) => apiFetch(`/api/library/${entry.id}`, {
            method: 'PATCH',
            body: { folderId: outputFolderId, bridgeId }
          }))
      )
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <LibraryDestinationDialog
      title={title}
      description={`Browse folders and move the selected file${files.length === 1 ? '' : 's'} into the folder that is currently open.`}
      details={(
        <Typography level="body-sm" textColor="text.tertiary">
          {files.length === 1
            ? formatLibraryFileName(files[0]?.name ?? '')
            : `${files.length} selected files`}
        </Typography>
      )}
      initialFolderId={initialFolderId}
      folders={folders}
      bridgeId={bridgeId}
      bridgeName={bridgeName}
      showRoot={showRoot}
      submitting={submitting}
      error={error}
      confirmStartDecorator={<DriveFileMoveRoundedIcon />}
      confirmActionLabel={({ outputFolderId, rootDestinationLabel: nextRootDestinationLabel }) => outputFolderId ? 'Move here' : `Move to ${nextRootDestinationLabel}`}
      emptyStateDescription={({ outputFolderId, rootDestinationLabel: nextRootDestinationLabel }) => outputFolderId
        ? 'Move here or choose another destination from the breadcrumb.'
        : `Move the selected files to ${nextRootDestinationLabel}, or create folders from the main Library page.`}
      onClose={onClose}
      onSubmit={({ outputFolderId }) => void submit(outputFolderId ?? null)}
    />
  )
}

export function MoveFilesModal({
  files,
  folders,
  bridgeId,
  bridgeName,
  showRoot,
  onClose,
  onSaved
}: {
  files: LibraryFile[]
  folders: LibraryFolder[]
  bridgeId: string | null
  bridgeName: string | null
  showRoot: boolean
  onClose: () => void
  onSaved: () => void
}) {
  return (
    <MoveFilesDialog
      files={files}
      folders={folders}
      bridgeId={bridgeId}
      bridgeName={bridgeName}
      showRoot={showRoot}
      title="Move files"
      onClose={onClose}
      onSaved={onSaved}
    />
  )
}
