/**
 * Version-history dialog for a library file: lists every stored version with its
 * per-version actions (print / edit / preview / download / restore). Self-contained
 * and props-only — it owns its own versions query and restore mutation, and surfaces
 * action intents (print/slice/preview a version) back to the caller via callbacks so
 * the page can open the matching dialog. Owns the version helpers nothing else uses.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Card, CardContent, Chip, CircularProgress, DialogActions, Stack, Typography } from '@mui/joy'
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded'
import DesignServicesRoundedIcon from '@mui/icons-material/DesignServicesRounded'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import PrintRoundedIcon from '@mui/icons-material/PrintRounded'
import RestoreRoundedIcon from '@mui/icons-material/RestoreRounded'
import VisibilityRoundedIcon from '@mui/icons-material/VisibilityRounded'
import { formatBytes, isDirectPrintableFileName } from '@printstream/shared'
import type { LibraryFile, LibraryFileVersion, LibraryFileVersionsResponse } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { buildApiUrl } from '../../lib/apiUrl'
import { formatLibraryFileName } from '../../lib/libraryDisplay'
import { buildLibraryFileMetaTags, isUnslicedThreeMfFile } from '../../lib/libraryFileTags'
import { invalidateLibraryQueries } from '../../lib/libraryQueryInvalidation'
import { toast } from '../../lib/toast'
import { BackAwareModal as Modal } from '../BackAwareModal'
import { DialogFileTitle } from '../DialogFileTitle'
import { usePromptDialog } from '../PromptDialogProvider'
import { ScrollableDialogBody, ScrollableModalDialog } from '../ScrollableDialog'

function buildLibraryHistoryDownloadHref(version: LibraryFileVersion): string {
  return buildApiUrl(version.versionId
    ? `/api/library/versions/${version.versionId}/download`
    : `/api/library/${version.libraryFileId}/download`)
}

/**
 * Mirror of the model-studio preview's supported modes: STL, STEP (tessellated server-side),
 * plated 3MF projects, and plate-scoped sliced gcode 3MFs all render read-only from version bytes.
 */
function isVersionPreviewable(version: LibraryFileVersion): boolean {
  return version.kind === 'stl' || version.kind === 'step' || version.kind === '3mf' || version.name.toLowerCase().endsWith('.gcode.3mf')
}

function formatVersionTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

export function FileHistoryDialog({
  file,
  canManageLibrary,
  canDispatchPrints,
  canSliceFiles,
  canViewPrinters,
  onClose,
  onPrintVersion,
  onSliceVersion,
  onPrintProjectVersion,
  onPreviewVersion,
  onRestored
}: {
  file: LibraryFile
  canManageLibrary: boolean
  canDispatchPrints: boolean
  canSliceFiles: boolean
  canViewPrinters: boolean
  onClose: () => void
  onPrintVersion: (version: LibraryFileVersion) => void
  onSliceVersion: (version: LibraryFileVersion) => void
  /** Slice-then-print for unsliced project 3MFs, mirroring the kebab's Print. */
  onPrintProjectVersion: (version: LibraryFileVersion) => void
  onPreviewVersion: (version: LibraryFileVersion) => void
  onRestored: () => void
}) {
  const queryClient = useQueryClient()
  const { confirm } = usePromptDialog()
  const historyQuery = useQuery({
    queryKey: ['library-file-versions', file.id],
    queryFn: () => apiFetch<LibraryFileVersionsResponse>(`/api/library/${file.id}/versions`)
  })
  const deleteVersion = useMutation({
    mutationFn: async (versionId: string) => {
      await apiFetch(`/api/library/versions/${versionId}`, { method: 'DELETE' })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['library-file-versions', file.id] })
      await invalidateLibraryQueries(queryClient)
      toast.success('Version deleted')
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to delete version')
    }
  })
  const restoreVersion = useMutation({
    mutationFn: async (versionId: string) => {
      await apiFetch<{ file: LibraryFile }>(`/api/library/versions/${versionId}/restore`, { method: 'POST' })
    },
    onSuccess: async () => {
      await invalidateLibraryQueries(queryClient)
      await queryClient.invalidateQueries({ queryKey: ['library-file-versions', file.id] })
      onRestored()
      toast.success('Version restored')
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to restore version')
    }
  })
  // Deleting the current version reverts the file to the most recent prior version, which
  // becomes the new current. Keyed on the file id (the current version isn't a version row).
  const deleteCurrentVersion = useMutation({
    mutationFn: async () => {
      await apiFetch(`/api/library/${file.id}/current-version`, { method: 'DELETE' })
    },
    onSuccess: async () => {
      await invalidateLibraryQueries(queryClient)
      await queryClient.invalidateQueries({ queryKey: ['library-file-versions', file.id] })
      onRestored()
      toast.success('Current version deleted')
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to delete current version')
    }
  })

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ maxWidth: 720, width: '100%' }}>
        <DialogFileTitle title="Version history" fileName={formatLibraryFileName(file.name)} />
        <ScrollableDialogBody sx={{ px: 0 }}>
          {historyQuery.isLoading && (
            <Stack alignItems="center" justifyContent="center" sx={{ py: 4 }}>
              <CircularProgress size="sm" />
            </Stack>
          )}
          {historyQuery.isError && (
            <Alert color="danger" variant="soft">
              {(historyQuery.error as Error).message || 'Failed to load version history'}
            </Alert>
          )}
          {historyQuery.data && (
            <Stack spacing={1.5}>
              {historyQuery.data.versions.map((version) => {
                const printable = canDispatchPrints && isDirectPrintableFileName(version.name)
                const sliceable = canSliceFiles && isUnslicedThreeMfFile(version)
                // Same gate as the kebab's slice-then-print action on project 3MFs.
                const projectPrintable = canDispatchPrints && canViewPrinters && canSliceFiles && isUnslicedThreeMfFile(version)
                const previewable = isVersionPreviewable(version)
                const restoring = restoreVersion.isPending && restoreVersion.variables === version.versionId
                const deleting = deleteVersion.isPending && deleteVersion.variables === version.versionId
                return (
                  <Card key={version.versionId ?? `${version.libraryFileId}-current`} variant="outlined" size="sm">
                    <CardContent>
                      <Stack spacing={1}>
                        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" sx={{ flexWrap: 'wrap', gap: 1 }}>
                          <Stack spacing={0.25} sx={{ minWidth: 0 }}>
                            <Stack direction="row" spacing={0.75} alignItems="center" sx={{ flexWrap: 'wrap', gap: 0.75 }}>
                              <Typography level="title-sm">Version {version.versionNumber}</Typography>
                              {version.isCurrent && <Chip size="sm" color="primary" variant="soft">Current</Chip>}
                              {version.restoredFromVersionNumber != null && (
                                <Chip size="sm" color="neutral" variant="soft">
                                  Restored from v{version.restoredFromVersionNumber}
                                </Chip>
                              )}
                            </Stack>
                            <Typography level="body-sm" textColor="text.tertiary">
                              {formatVersionTimestamp(version.uploadedAt)}
                              {version.createdByName
                                ? ` · ${version.restoredFromVersionNumber != null ? 'Restored by' : 'Added by'} ${version.createdByName}`
                                : ''}
                            </Typography>
                          </Stack>
                          <Typography level="body-sm" textColor="text.tertiary">
                            {formatBytes(version.sizeBytes)}
                          </Typography>
                        </Stack>

                        <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
                          {buildLibraryFileMetaTags(version).map((tag) => (
                            <Chip key={`${version.versionNumber}-${tag.key}`} size="sm" variant="soft" color={tag.color}>
                              {tag.label}
                            </Chip>
                          ))}
                        </Stack>

                        {/* Same action order as the library file kebab menu:
                            Print / Edit / Print (project) / Preview / Download, then Restore. */}
                        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          {printable && (
                            <Button size="sm" variant="soft" startDecorator={<PrintRoundedIcon />} onClick={() => onPrintVersion(version)}>
                              Print
                            </Button>
                          )}
                          {sliceable && (
                            <Button size="sm" variant="soft" startDecorator={<DesignServicesRoundedIcon />} onClick={() => onSliceVersion(version)}>
                              Edit
                            </Button>
                          )}
                          {projectPrintable && (
                            <Button size="sm" variant="soft" startDecorator={<PrintRoundedIcon />} onClick={() => onPrintProjectVersion(version)}>
                              Print
                            </Button>
                          )}
                          {previewable && (
                            <Button size="sm" variant="soft" startDecorator={<VisibilityRoundedIcon />} onClick={() => onPreviewVersion(version)}>
                              Preview
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="soft"
                            component="a"
                            href={buildLibraryHistoryDownloadHref(version)}
                            download={version.name}
                            startDecorator={<DownloadRoundedIcon />}
                          >
                            Download
                          </Button>
                          {canManageLibrary && !version.isCurrent && version.versionId && (
                            <Button
                              size="sm"
                              variant="solid"
                              loading={restoring}
                              startDecorator={<RestoreRoundedIcon />}
                              onClick={() => restoreVersion.mutate(version.versionId!)}
                            >
                              Restore current
                            </Button>
                          )}
                          {canManageLibrary && !version.isCurrent && version.versionId && (
                            <Button
                              size="sm"
                              variant="soft"
                              color="danger"
                              loading={deleting}
                              startDecorator={<DeleteOutlineRoundedIcon />}
                              onClick={async () => {
                                const confirmed = await confirm({
                                  title: 'Delete version?',
                                  description: `Permanently delete version ${version.versionNumber} of “${formatLibraryFileName(file.name)}”? This cannot be undone.`,
                                  confirmLabel: 'Delete version',
                                  color: 'danger'
                                })
                                if (confirmed) deleteVersion.mutate(version.versionId!)
                              }}
                            >
                              Delete
                            </Button>
                          )}
                          {/* Deleting the current version reverts to the most recent prior
                              version; only offered when there is one to fall back to. */}
                          {canManageLibrary && version.isCurrent && historyQuery.data.versions.some((entry) => !entry.isCurrent) && (
                            <Button
                              size="sm"
                              variant="soft"
                              color="danger"
                              loading={deleteCurrentVersion.isPending}
                              startDecorator={<DeleteOutlineRoundedIcon />}
                              onClick={async () => {
                                const fallback = Math.max(
                                  ...historyQuery.data.versions.filter((entry) => !entry.isCurrent).map((entry) => entry.versionNumber)
                                )
                                const confirmed = await confirm({
                                  title: 'Delete current version?',
                                  description: `Delete the current version (${version.versionNumber}) of “${formatLibraryFileName(file.name)}”? The file will revert to version ${fallback}. This cannot be undone.`,
                                  confirmLabel: 'Delete current version',
                                  color: 'danger'
                                })
                                if (confirmed) deleteCurrentVersion.mutate()
                              }}
                            >
                              Delete
                            </Button>
                          )}
                        </Stack>
                      </Stack>
                    </CardContent>
                  </Card>
                )
              })}
            </Stack>
          )}
        </ScrollableDialogBody>
        <DialogActions>
          <Button variant="plain" onClick={onClose}>Close</Button>
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
  )
}
