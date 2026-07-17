/**
 * Folder-picker dialog for "save / move into the library" flows. Save flows
 * (`showFiles`) also list the files in the destination folder: clicking one
 * fills the name field, and submitting a name whose final form (base name +
 * declared extension) exactly matches an existing file asks for confirmation
 * before replacing it (the server archives the replaced content as a version).
 */
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { Box, Button, FormControl, FormHelperText, FormLabel, IconButton, Input, Sheet, Stack, Tooltip, Typography } from '@mui/joy'
import FolderOpenRoundedIcon from '@mui/icons-material/FolderOpenRounded'
import GridViewRoundedIcon from '@mui/icons-material/GridViewRounded'
import ViewListRoundedIcon from '@mui/icons-material/ViewListRounded'
import { useQuery } from '@tanstack/react-query'
import type { LibraryBrowseResponse, LibraryFolder } from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { formatLibraryFileName, splitLibraryFileNameForRename } from '../lib/libraryDisplay'
import { findLibrarySaveConflict } from '../lib/librarySaveConflict'
import { EmptyState } from './EmptyState'
import { LibraryBreadcrumb } from './LibraryBreadcrumb'
import { BackAwareModal as Modal } from './BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'
import { LibraryBrowser, type LibrarySort, type LibraryViewMode } from './LibraryBrowser'
import { buildLibraryBreadcrumb, isBridgeFolderId } from '../lib/libraryNavigation'
import { usePromptDialog } from './PromptDialogProvider'

const DESTINATION_DIALOG_SORT: LibrarySort = { key: 'name', dir: 'asc' }

export function LibraryDestinationDialog({
  title,
  description,
  details,
  fileNameField,
  initialFolderId,
  folders,
  bridgeId,
  bridgeName,
  showRoot,
  showFiles = false,
  dialogWidth = 920,
  submitting,
  error,
  confirmStartDecorator,
  confirmActionLabel,
  emptyStateDescription,
  onClose,
  onSubmit
}: {
  title: string
  description: string
  details?: ReactNode
  fileNameField?: {
    label: string
    initialValue: string
    /**
     * Extension the server appends to the saved name (e.g. '.gcode.3mf').
     * Shown read-only at the end of the input so the final filename is clear
     * without letting the user edit it away.
     */
    extension?: string
  }
  initialFolderId: string | null
  folders: LibraryFolder[]
  bridgeId: string | null
  bridgeName: string | null
  showRoot: boolean
  /**
   * List the destination folder's files (save flows): picking one fills the
   * name field, and an exact final-name match asks to replace that file.
   */
  showFiles?: boolean
  dialogWidth?: number
  submitting: boolean
  error: string | null
  confirmStartDecorator?: ReactNode
  confirmActionLabel: (input: { outputFolderId: string | null; rootDestinationLabel: string }) => string
  emptyStateDescription?: (input: { outputFolderId: string | null; rootDestinationLabel: string }) => string
  onClose: () => void
  onSubmit: (input: { outputFileName?: string; outputFolderId: string | null }) => void
}) {
  const { confirm } = usePromptDialog()
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(initialFolderId)
  const [outputFileName, setOutputFileName] = useState(fileNameField?.initialValue ?? '')
  // Pre-select the suggested name the first time the field is focused (autoFocus drives that on
  // open) so the user can type a new name straight over it. Doing it on focus rather than in a
  // mount effect avoids racing Joy's modal focus management, which would clear an early select().
  const fileNameSelectedRef = useRef(false)
  const [viewMode, setViewMode] = useState<LibraryViewMode>('list')
  const childFolders = useMemo(
    () => folders.filter((folder) => folder.parentId === currentFolderId),
    [folders, currentFolderId]
  )
  const destinationFilesQuery = useQuery({
    queryKey: ['library-destination-files', bridgeId ?? 'none', currentFolderId ?? 'root'],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams()
      if (currentFolderId) params.set('folderId', currentFolderId)
      if (bridgeId) params.set('bridgeId', bridgeId)
      const search = params.toString()
      return apiFetch<LibraryBrowseResponse>(`/api/library/browse${search ? `?${search}` : ''}`, { signal })
    },
    enabled: showFiles
  })
  const destinationFiles = useMemo(
    () => (showFiles ? destinationFilesQuery.data?.files ?? [] : []),
    [destinationFilesQuery.data, showFiles]
  )
  const breadcrumb = useMemo(
    () => buildLibraryBreadcrumb(folders, currentFolderId, bridgeId, bridgeName, {
      showRoot,
      rootNavigable: false
    }),
    [bridgeId, bridgeName, folders, currentFolderId, showRoot]
  )
  const rootDestinationLabel = bridgeName ?? 'Bridge root'
  // The extension renders read-only after the input; if the user types it
  // anyway, fold it into the suffix instead of letting it double up.
  const rawOutputFileName = outputFileName.trim()
  const trimmedOutputFileName = fileNameField?.extension && rawOutputFileName.toLowerCase().endsWith(fileNameField.extension.toLowerCase())
    ? rawOutputFileName.slice(0, -fileNameField.extension.length).trim()
    : rawOutputFileName
  const canSubmit = (fileNameField ? trimmedOutputFileName.length > 0 : true) && !submitting

  // A save name collides only when the FINAL name (base + declared extension)
  // matches an existing file exactly — the server's replace predicate. A looser
  // base-name match would warn about files the save won't touch (e.g. saving
  // `benchy` + `.gcode.3mf` next to `benchy.gcode`).
  const conflictingFile = useMemo(() => {
    if (!showFiles || !fileNameField) return null
    return findLibrarySaveConflict(destinationFiles, trimmedOutputFileName, fileNameField.extension)
  }, [destinationFiles, fileNameField, showFiles, trimmedOutputFileName])

  const submit = async () => {
    if (conflictingFile) {
      const confirmed = await confirm({
        title: 'Replace existing file?',
        description: `"${formatLibraryFileName(conflictingFile.name)}" already exists in this destination. Saving will replace it; the current content stays available in its version history.`,
        confirmLabel: 'Replace file',
        color: 'danger'
      })
      if (!confirmed) return
    }
    onSubmit({ outputFileName: fileNameField ? trimmedOutputFileName : undefined, outputFolderId: currentFolderId })
  }

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: { xs: '100%', md: dialogWidth } }}>
        <Typography level="h4">{title}</Typography>
        <ScrollableDialogBody sx={{ mt: 1.5, p: 0 }}>
          <Stack spacing={1.5} sx={{ minHeight: 420, minWidth: 0 }}>
            <Typography level="body-sm" textColor="text.secondary">
              {description}
            </Typography>

            {details ?? null}

            {fileNameField ? (
              <FormControl>
                <FormLabel>{fileNameField.label}</FormLabel>
                <Input
                  autoFocus
                  onFocus={(event) => {
                    if (fileNameSelectedRef.current) return
                    fileNameSelectedRef.current = true
                    event.currentTarget.select()
                  }}
                  value={outputFileName}
                  onChange={(event) => setOutputFileName(event.target.value)}
                  endDecorator={fileNameField.extension ? (
                    <Typography level="body-sm" textColor="text.tertiary" sx={{ userSelect: 'none' }}>
                      {fileNameField.extension}
                    </Typography>
                  ) : undefined}
                />
                {conflictingFile && (
                  <FormHelperText sx={{ color: 'warning.plainColor' }}>
                    Replaces "{formatLibraryFileName(conflictingFile.name)}" in this folder.
                  </FormHelperText>
                )}
              </FormControl>
            ) : null}

            <LibraryBreadcrumb
              crumbs={breadcrumb}
              onNavigate={(folderEntryId) => {
                if (folderEntryId && isBridgeFolderId(folderEntryId)) {
                  setCurrentFolderId(null)
                  return
                }
                setCurrentFolderId(folderEntryId)
              }}
            />

            <Stack direction="row" justifyContent="flex-end" spacing={1}>
              <Tooltip title="List view">
                <IconButton
                  size="sm"
                  variant={viewMode === 'list' ? 'solid' : 'soft'}
                  color={viewMode === 'list' ? 'primary' : 'neutral'}
                  aria-label="List view"
                  aria-pressed={viewMode === 'list'}
                  onClick={() => setViewMode('list')}
                >
                  <ViewListRoundedIcon />
                </IconButton>
              </Tooltip>
              <Tooltip title="Icon view">
                <IconButton
                  size="sm"
                  variant={viewMode === 'icon' ? 'solid' : 'soft'}
                  color={viewMode === 'icon' ? 'primary' : 'neutral'}
                  aria-label="Icon view"
                  aria-pressed={viewMode === 'icon'}
                  onClick={() => setViewMode('icon')}
                >
                  <GridViewRoundedIcon />
                </IconButton>
              </Tooltip>
            </Stack>

            <Sheet
              variant="outlined"
              sx={{ p: 1.25, borderRadius: 'md', minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}
            >
              <LibraryBrowser
                folders={childFolders}
                files={destinationFiles}
                viewMode={viewMode}
                sort={DESTINATION_DIALOG_SORT}
                onFolderOpen={(folder) => setCurrentFolderId(folder.id)}
                onFilePick={fileNameField
                  ? (file) => setOutputFileName(splitLibraryFileNameForRename(file.name).baseName)
                  : undefined}
                isFilePickable={fileNameField ? () => true : undefined}
                emptyState={
                  <Box sx={{ flex: 1, minHeight: '100%', display: 'grid', placeItems: 'center' }}>
                    <EmptyState
                      icon={<FolderOpenRoundedIcon />}
                      title={currentFolderId ? 'No subfolders here' : 'No folders in the library yet'}
                      description={
                        emptyStateDescription
                          ? emptyStateDescription({ outputFolderId: currentFolderId, rootDestinationLabel })
                          : currentFolderId
                            ? 'Choose this folder or use the breadcrumb to pick another destination.'
                            : `Choose ${rootDestinationLabel}, or open a subfolder.`
                      }
                    />
                  </Box>
                }
              />
            </Sheet>
          </Stack>
        </ScrollableDialogBody>
        {error && <Typography color="danger" level="body-sm">{error}</Typography>}
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
          <Button variant="plain" onClick={onClose}>Cancel</Button>
          <Button
            loading={submitting}
            disabled={!canSubmit}
            startDecorator={confirmStartDecorator}
            onClick={() => void submit()}
          >
            {confirmActionLabel({ outputFolderId: currentFolderId, rootDestinationLabel })}
          </Button>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}
