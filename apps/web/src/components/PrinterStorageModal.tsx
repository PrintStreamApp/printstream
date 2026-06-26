/**
 * Browse, manage and print files stored directly on a Bambu printer.
 *
 * The picker uses the printer's FTPS server (not the local library).
 * Layout mirrors `LibraryBrowser`'s list mode for visual consistency:
 * folders first, then files, single-click navigates / opens an actions
 * menu, ⋮ on each row exposes Print / Rename / Delete.
 *
 * Folder navigation is driven by a normalised printer-absolute path.
 * The toolbar shows breadcrumbs and a Back button; root is `'/'`.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Box, Button, Checkbox, Dropdown, IconButton, LinearProgress, Menu, MenuButton, MenuItem,
  ModalClose, Stack, Typography
} from '@mui/joy'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import EditRoundedIcon from '@mui/icons-material/EditRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import PrintRoundedIcon from '@mui/icons-material/PrintRounded'
import {
  deleteOperationResponseSchema,
  extractErrorMessage,
  isDirectPrintableFileName,
  startPrinterStorageDeleteJobSchema,
  formatBytes,
  type PrintNozzleOffsetCalibrationMode,
  type PrintOnOffAutoMode,
  type PrinterModel,
  type PrinterStorageList,
  type PrinterTrayMapping
} from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { buildApiUrl } from '../lib/apiUrl'
import { useElementVisibility } from '../hooks/useElementVisibility'
import { useMobileViewport } from './useMobileViewport'
import { splitLibraryFileNameForRename } from '../lib/libraryDisplay'
import { formatDateTime } from '../lib/time'
import { toast } from '../lib/toast'
import { BackAwareModal as Modal } from './BackAwareModal'
import { DialogSection } from './DialogSection'
import { usePromptDialog } from './PromptDialogProvider'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'
import { SquareMediaFrame } from './SquareMediaFrame'
import { StoragePrintModal } from './StoragePrintModal'

/** Three-dot vertical glyph. Inlined here to avoid importing back into the pages layer. */
function MoreVertIcon() {
  return (
    <Box
      component="svg"
      viewBox="0 0 24 24"
      aria-hidden
      sx={{ width: '1.1em', height: '1.1em', fill: 'currentColor' }}
    >
      <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
    </Box>
  )
}

function joinPath(parent: string, name: string): string {
  if (parent === '/' || parent === '') return `/${name}`
  return `${parent.replace(/\/+$/, '')}/${name}`
}

function parentPath(p: string): string {
  if (p === '/' || p === '') return '/'
  const idx = p.lastIndexOf('/')
  return idx <= 0 ? '/' : p.slice(0, idx)
}

interface Props {
  printerId: string
  printerName: string
  printerModel: PrinterModel
  onClose: () => void
  /** Optional starting directory. Defaults to `/`. */
  initialPath?: string
  /**
   * Optional file-name filter. When set, only matching files are shown.
   * Folders are always shown so the user can keep navigating.
   */
  acceptExtensions?: RegExp
  /** Override the dialog title (defaults to `<printerName> files`). */
  title?: string
  /** Optional descriptive subtitle below the title. */
  description?: string
  /**
   * When false, files cannot be printed from this dialog (used by the
   * Timelapses browser, which is just for inspection/cleanup).
   */
  allowPrint?: boolean
  /**
    * When false, the Upload button is hidden. Defaults to true. The file is
    * uploaded directly to the current printer-storage folder.
    */
    allowUpload?: boolean
    /**
    * Optional media preview mode for flat file browsers.
    */
  previewKind?: 'model' | 'timelapse'
  /** When true, expose a Download action for files. */
  allowDownload?: boolean
  /** When false, hide rename/delete/select actions. */
  allowManage?: boolean
  /**
   * When true, render a flat recursive listing of files only — no path
   * bar, no folder navigation, no folder rows. Used by the Models
   * browser to mirror what Bambu Studio / Handy show: a single list of
   * sliced files regardless of where they live on the SD card.
   */
  flat?: boolean
}

export function PrinterStorageModal({
  printerId,
  printerName,
  printerModel,
  onClose,
  initialPath = '/',
  acceptExtensions,
  title,
  description,
  allowPrint = true,
  allowUpload = true,
  previewKind,
  allowDownload = false,
  allowManage = true,
  flat = false
}: Props) {
  const { confirm, promptText } = usePromptDialog()
  const [path, setPath] = useState(initialPath)
  const [printTarget, setPrintTarget] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedEntryPaths, setSelectedEntryPaths] = useState<string[]>([])
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const isMobileViewport = useMobileViewport()
  const queryClient = useQueryClient()

  const listQuery = useQuery({
    queryKey: ['printer-storage', printerId, path, flat],
    queryFn: ({ signal }) =>
      apiFetch<PrinterStorageList>(
        `/api/printers/${printerId}/storage?path=${encodeURIComponent(path)}${flat ? '&recursive=1' : ''}`,
        { signal }
      )
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['printer-storage', printerId] })

  const startDeleteJob = useMutation({
    mutationFn: async (entries: Array<{ path: string; type: 'file' | 'directory' }>) => {
      const payload = startPrinterStorageDeleteJobSchema.parse({ entries })
      const response = await apiFetch(`/api/printers/${printerId}/storage/delete-jobs`, {
        method: 'POST',
        body: payload
      })
      return deleteOperationResponseSchema.parse(response)
    },
    onSuccess: async () => {
      setSelectedEntryPaths([])
      setSelectionMode(false)
      await queryClient.invalidateQueries({ queryKey: ['delete-operations'] })
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to start delete job')
    }
  })

  const renameMutation = useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) =>
      apiFetch<void>(`/api/printers/${printerId}/storage/rename`, {
        method: 'POST',
        body: { from, to }
      }),
    onSuccess: invalidate
  })

  const printMutation = useMutation({
    mutationFn: (args: {
      filePath: string
      plate: number
      bedLevel: PrintOnOffAutoMode
      vibrationCompensation: boolean
      flowCalibration: PrintOnOffAutoMode
      timelapse: boolean
      nozzleOffsetCalibration: PrintNozzleOffsetCalibrationMode
      amsMapping?: PrinterTrayMapping[]
      allowIncompatibleFilament: boolean
    }) =>
      apiFetch<{ path: string }>(`/api/printers/${printerId}/storage/print`, {
        method: 'POST',
        body: {
          path: args.filePath,
          plate: args.plate,
          useAms: true,
          bedLevel: args.bedLevel,
          vibrationCompensation: args.vibrationCompensation,
          timelapse: args.timelapse,
          flowCalibration: args.flowCalibration,
          filamentDynamicsCalibration: false,
          nozzleOffsetCalibration: args.nozzleOffsetCalibration,
          amsMapping: args.amsMapping,
          allowIncompatibleFilament: args.allowIncompatibleFilament
        }
      }),
    onSuccess: () => {
      setPrintTarget(null)
      onClose()
    }
  })

  const uploadMutation = useMutation({
    mutationFn: (file: File) =>
      new Promise<{ path: string }>((resolve, reject) => {
        const form = new FormData()
        form.append('file', file)
        const xhr = new XMLHttpRequest()
        xhr.open('POST', buildApiUrl(`/api/printers/${printerId}/storage/upload?path=${encodeURIComponent(path)}`))
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) setUploadProgress(event.loaded / event.total)
        }
        xhr.onload = () => {
          setUploadProgress(null)
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText))
            } catch {
              resolve({ path })
            }
            return
          }
          let payload: unknown = xhr.responseText
          try { payload = JSON.parse(xhr.responseText) } catch { /* keep text */ }
          reject(new Error(extractErrorMessage(payload, `Upload failed (${xhr.status})`)))
        }
        xhr.onerror = () => {
          setUploadProgress(null)
          reject(new Error('Upload failed'))
        }
        setUploadProgress(0)
        xhr.send(form)
      }),
    onSuccess: async () => {
      toast.success('Uploaded to printer storage')
      await invalidate()
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Upload failed')
    }
  })

  // Apply caller-provided extension filter to files only — folders are
  // kept so the user can drill in further (e.g. into `/cache/`). In
  // flat mode all entries are files anyway, but we drop any stray
  // directory entries defensively and apply the filter.
  const visibleEntries = useMemo(() => {
    let list = listQuery.data?.entries ?? []
    if (flat) list = list.filter((entry) => entry.type === 'file')
    if (acceptExtensions) {
      list = list.filter(
        (entry) => (!flat && entry.type === 'directory') || acceptExtensions.test(entry.name)
      )
    }
    return list
  }, [acceptExtensions, flat, listQuery.data?.entries])
  const selectableEntries = useMemo(
    () => visibleEntries.filter((entry) => entry.type === 'file'),
    [visibleEntries]
  )
  const selectedVisibleEntryPaths = selectedEntryPaths.filter((entryPath) =>
    selectableEntries.some((entry) => (entry.path ?? joinPath(path, entry.name)) === entryPath)
  )
  const isRoot = path === '/'

  useEffect(() => {
    setSelectedEntryPaths((current) => {
      const next = current.filter((entryPath) =>
        selectableEntries.some((entry) => (entry.path ?? joinPath(path, entry.name)) === entryPath)
      )
      return next.length === current.length ? current : next
    })
  }, [path, selectableEntries])

  useEffect(() => {
    setSelectionMode(false)
    setSelectedEntryPaths([])
  }, [path])

  const toggleSelectedEntry = (entryPath: string) => {
    setSelectedEntryPaths((current) => current.includes(entryPath)
      ? current.filter((value) => value !== entryPath)
      : [...current, entryPath])
  }

  const toggleAllVisibleEntries = () => {
    setSelectedEntryPaths((current) => (
      current.length === selectableEntries.length
        ? []
        : selectableEntries.map((entry) => entry.path ?? joinPath(path, entry.name))
    ))
  }

  const deleteSelectedEntries = async () => {
    if (selectedVisibleEntryPaths.length === 0) return
    const confirmed = await confirm({
      title: 'Delete selected files?',
      description: selectedVisibleEntryPaths.length === 1
        ? `Delete file "${selectedVisibleEntryPaths[0]?.split('/').pop() ?? ''}"?`
        : `Delete ${selectedVisibleEntryPaths.length} selected files?`,
      confirmLabel: 'Delete files',
      color: 'danger'
    })
    if (!confirmed) return
    await startDeleteJob.mutateAsync(selectedVisibleEntryPaths.map((entryPath) => ({ path: entryPath, type: 'file' as const })))
  }

  return (
    <>
      <Modal open onClose={onClose}>
        <ScrollableModalDialog sx={{ width: { xs: '100%', sm: 720 } }}>
        <ModalClose />
        <Typography level="h4">{title ?? `${printerName} files`}</Typography>
        <Typography level="body-sm" textColor="text.tertiary" sx={{ mb: 1 }}>
          {description ?? "Files stored on the printer's SD card."}
        </Typography>

        <ScrollableDialogBody sx={{ p: 0 }}>
          <Stack spacing={2}>
            {!flat && (
              <DialogSection title="Location">
                <Stack direction="row" spacing={1} alignItems="center">
                  <Button
                    size="sm"
                    variant="plain"
                    disabled={isRoot}
                    onClick={() => setPath(parentPath(path))}
                  >
                    ← Back
                  </Button>
                  <Box
                    component="input"
                    value={path}
                    onChange={(e) => setPath((e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') invalidate()
                    }}
                    spellCheck={false}
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      px: 1,
                      py: 0.5,
                      fontFamily: 'monospace',
                      fontSize: '0.85rem',
                      color: 'var(--joy-palette-text-primary)',
                      backgroundColor: 'var(--joy-palette-background-surface)',
                      border: '1px solid var(--joy-palette-neutral-700)',
                      borderRadius: 'sm'
                    }}
                  />
                </Stack>
              </DialogSection>
            )}

            <DialogSection title="Files">
              <Stack spacing={1}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 1 }}>
                  {flat && <Box sx={{ flex: 1 }} />}
                  {allowManage && selectionMode ? (
                    <>
                      {selectableEntries.length > 0 && (
                        <Button
                          size="sm"
                          variant="soft"
                          onClick={toggleAllVisibleEntries}
                          disabled={startDeleteJob.isPending}
                        >
                          {selectedVisibleEntryPaths.length === selectableEntries.length ? 'Clear all' : 'Select all'}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="plain"
                        onClick={() => {
                          setSelectionMode(false)
                          setSelectedEntryPaths([])
                        }}
                        disabled={startDeleteJob.isPending}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        color="danger"
                        variant="soft"
                        startDecorator={<DeleteRoundedIcon />}
                        disabled={selectedVisibleEntryPaths.length === 0}
                        loading={startDeleteJob.isPending}
                        onClick={() => void deleteSelectedEntries()}
                      >
                        Delete selected{selectedVisibleEntryPaths.length > 0 ? ` (${selectedVisibleEntryPaths.length})` : ''}
                      </Button>
                    </>
                  ) : allowManage && selectableEntries.length > 0 && !isMobileViewport ? (
                    <Button
                      size="sm"
                      variant="soft"
                      onClick={() => setSelectionMode(true)}
                      disabled={startDeleteJob.isPending}
                    >
                      Select...
                    </Button>
                  ) : null}
                  {allowUpload && (
                    <>
                      <Button
                        size="sm"
                        variant="soft"
                        color="primary"
                        loading={uploadMutation.isPending}
                        disabled={startDeleteJob.isPending}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        Upload…
                      </Button>
                      <Box
                        component="input"
                        type="file"
                        ref={fileInputRef}
                        sx={{ display: 'none' }}
                        onChange={(event) => {
                          const target = event.target as HTMLInputElement
                          const file = target.files?.[0]
                          target.value = ''
                          if (file) uploadMutation.mutate(file)
                        }}
                      />
                    </>
                  )}
                </Stack>
                {uploadProgress != null && (
                  <Stack spacing={0.5}>
                    <LinearProgress
                      determinate={uploadProgress > 0}
                      value={Math.round(uploadProgress * 100)}
                    />
                    <Typography level="body-xs" textColor="text.tertiary">
                      Uploading… {Math.round(uploadProgress * 100)}%
                    </Typography>
                  </Stack>
                )}

                {listQuery.isLoading && (
                  <Typography level="body-sm" textColor="text.tertiary">Loading…</Typography>
                )}
                {listQuery.isError && (
                  <Typography level="body-sm" color="danger">
                    {(listQuery.error as Error).message}
                  </Typography>
                )}
                {!listQuery.isLoading && !listQuery.isError && visibleEntries.length === 0 && (
                  <Typography level="body-sm" textColor="text.tertiary">
                    {acceptExtensions ? 'No matching files in this folder.' : 'This folder is empty.'}
                  </Typography>
                )}

                <Stack spacing={1}>
                  {visibleEntries.map((entry) => {
                // In recursive (flat) mode the server provides an absolute
                // path on each entry; otherwise we synthesize it from the
                // current directory + entry name.
                const entryPath = entry.path ?? joinPath(path, entry.name)
                const isDir = entry.type === 'directory'
                const isPrintable =
                  !isDir && allowPrint && isDirectPrintableFileName(entry.name)
                const onPrimary = isDir
                  ? () => setPath(entryPath)
                  : selectionMode
                    ? () => toggleSelectedEntry(entryPath)
                  : isPrintable
                    ? () => setPrintTarget(entryPath)
                    : undefined
                    return (
                      <StorageRow
                        key={entryPath}
                        name={entry.name}
                        isDir={isDir}
                        isPrintable={isPrintable}
                        showInlineDownload={previewKind === 'timelapse'}
                        previewUrl={!isDir && (previewKind === 'model' || previewKind === 'timelapse')
                          ? buildApiUrl(`/api/printers/${printerId}/storage/thumbnail?path=${encodeURIComponent(entryPath)}`)
                          : null}
                        downloadUrl={!isDir && allowDownload
                          ? buildApiUrl(`/api/printers/${printerId}/storage/download?path=${encodeURIComponent(entryPath)}`)
                          : null}
                        meta={
                          isDir
                            ? 'Folder'
                            : `${formatBytes(entry.sizeBytes)}${entry.modifiedAt ? ` · ${formatDateTime(entry.modifiedAt)}` : ''}`
                        }
                        onPrimary={onPrimary}
                        onPrint={isPrintable ? () => setPrintTarget(entryPath) : undefined}
                        onRename={allowManage ? async () => {
                          const next = await promptText({
                            title: `Rename ${isDir ? 'folder' : 'file'}`,
                            description: `Enter a new name for "${entry.name}".`,
                            label: 'Name',
                            initialValue: entry.name,
                            // Files: pre-select only the basename so the extension survives an overtype.
                            initialSelection: isDir
                              ? undefined
                              : { start: 0, end: splitLibraryFileNameForRename(entry.name).baseName.length },
                            placeholder: entry.name,
                            confirmLabel: 'Rename',
                            normalizeValue: (value) => value.trim(),
                            validateValue: (value) => {
                              if (!value) return 'Enter a name.'
                              if (value === entry.name) return 'Enter a different name.'
                              return null
                            }
                          })
                          if (!next) return
                          renameMutation.mutate({ from: entryPath, to: joinPath(path, next) })
                        } : undefined}
                        onDelete={allowManage ? async () => {
                          const confirmed = await confirm({
                            title: `Delete ${isDir ? 'folder' : 'file'}?`,
                            description: `Delete ${isDir ? 'folder' : 'file'} "${entry.name}"?`,
                            confirmLabel: isDir ? 'Delete folder' : 'Delete file',
                            color: 'danger'
                          })
                          if (!confirmed) return
                          void startDeleteJob.mutateAsync([{ path: entryPath, type: entry.type }])
                        } : undefined}
                        selectable={allowManage && selectionMode && !isDir}
                        selected={selectedEntryPaths.includes(entryPath)}
                        onSelectionToggle={allowManage && selectionMode && !isDir ? () => toggleSelectedEntry(entryPath) : undefined}
                        actionsDisabled={startDeleteJob.isPending}
                      />
                    )
                  })}
                </Stack>
              </Stack>
            </DialogSection>
          </Stack>
        </ScrollableDialogBody>

        <Stack direction="row" justifyContent="flex-end" sx={{ pt: 1 }}>
          <Button variant="plain" onClick={onClose}>Close</Button>
        </Stack>
        </ScrollableModalDialog>
      </Modal>
      {printTarget && (
        <StoragePrintModal
          printerId={printerId}
          printerModel={printerModel}
          filePath={printTarget}
          submitting={printMutation.isPending}
          error={printMutation.error ? (printMutation.error as Error).message : null}
          onCancel={() => {
            printMutation.reset()
            setPrintTarget(null)
          }}
          onSubmit={(opts) =>
            printMutation.mutate({ filePath: printTarget, ...opts })
          }
        />
      )}
    </>
  )
}

function StorageRow({
  name,
  isDir,
  isPrintable,
  showInlineDownload,
  previewUrl,
  downloadUrl,
  meta,
  onPrimary,
  onPrint,
  onRename,
  onDelete,
  selectable = false,
  selected = false,
  onSelectionToggle,
  actionsDisabled = false
}: {
  name: string
  isDir: boolean
  isPrintable: boolean
  showInlineDownload: boolean
  previewUrl: string | null
  downloadUrl: string | null
  meta: string
  onPrimary?: () => void
  onPrint?: () => void
  onRename?: () => void
  onDelete?: () => void
  selectable?: boolean
  selected?: boolean
  onSelectionToggle?: () => void
  actionsDisabled?: boolean
}) {
  const interactive = Boolean(onPrimary)
  const hasMenuActions = Boolean(downloadUrl || onRename || onDelete)
  const rowRef = useRef<HTMLDivElement | null>(null)
  const rowVisible = useElementVisibility(rowRef, Boolean(previewUrl), 0.05)
  const [previewActivated, setPreviewActivated] = useState(false)

  useEffect(() => {
    if (!rowVisible) return
    setPreviewActivated(true)
  }, [rowVisible])

  return (
    <Box
      ref={rowRef}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        p: 1,
        borderRadius: 'sm',
        border: '1px solid var(--joy-palette-neutral-700)',
        backgroundColor: 'var(--joy-palette-background-surface)',
        '&:hover': interactive ? { borderColor: 'var(--joy-palette-primary-500)' } : undefined
      }}
    >
      {selectable && onSelectionToggle && (
        <Checkbox
          checked={selected}
          onClick={(event) => event.stopPropagation()}
          onChange={() => onSelectionToggle()}
          slotProps={{ input: { 'aria-label': `Select ${name}` } }}
        />
      )}
      <Box
        onClick={onPrimary}
        role={interactive ? 'button' : undefined}
        tabIndex={interactive ? 0 : undefined}
        onKeyDown={(event) => {
          if (!interactive) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onPrimary?.()
          }
        }}
        sx={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          cursor: interactive ? 'pointer' : 'default'
        }}
      >
        <SquareMediaFrame
          sx={{ width: 48, minWidth: 48 }}
          contentSx={{
            backgroundColor: isDir
              ? 'var(--joy-palette-primary-900)'
              : 'var(--joy-palette-neutral-800)',
            borderColor: isDir ? 'var(--joy-palette-primary-700)' : 'var(--joy-palette-neutral-700)'
          }}
        >
          <StoragePreview
            name={name}
            isDir={isDir}
            isPrintable={isPrintable}
            previewUrl={previewActivated ? previewUrl : null}
          />
        </SquareMediaFrame>
        <Stack sx={{ flex: 1, minWidth: 0 }} spacing={0.25}>
          <Typography level="title-sm" noWrap>{name}</Typography>
          <Typography level="body-xs" textColor="text.tertiary" noWrap>{meta}</Typography>
        </Stack>
      </Box>
      {showInlineDownload && downloadUrl && (
        <Button
          size="sm"
          variant="soft"
          component="a"
          href={downloadUrl}
          download={name}
          startDecorator={<DownloadRoundedIcon />}
        >
          Download
        </Button>
      )}
      {isPrintable && onPrint && (
        <Button size="sm" variant="soft" onClick={onPrint} startDecorator={<PrintRoundedIcon />} disabled={actionsDisabled}>Print</Button>
      )}
      {hasMenuActions && (
        <Dropdown>
          <MenuButton
            slots={{ root: IconButton }}
            slotProps={{ root: { size: 'sm', variant: 'plain', color: 'neutral', 'aria-label': `${name} actions`, disabled: actionsDisabled } }}
          >
            <MoreVertIcon />
          </MenuButton>
          <Menu placement="left-start" sx={{ zIndex: (theme) => theme.zIndex.tooltip }}>
            {downloadUrl && (
              <MenuItem component="a" href={downloadUrl} download={name}>
                <DownloadRoundedIcon /> Download
              </MenuItem>
            )}
            {onRename && (
              <MenuItem onClick={onRename}>
                <EditRoundedIcon /> Rename
              </MenuItem>
            )}
            {onDelete && (
              <MenuItem color="danger" onClick={onDelete}>
                <DeleteRoundedIcon /> Delete
              </MenuItem>
            )}
          </Menu>
        </Dropdown>
      )}
    </Box>
  )
}

function StoragePreview({
  name,
  isDir,
  isPrintable,
  previewUrl
}: {
  name: string
  isDir: boolean
  isPrintable: boolean
  previewUrl: string | null
}) {
  const [failed, setFailed] = useState(false)

  if (!isDir && previewUrl && !failed) {
    return (
      <Box
        component="img"
        src={previewUrl}
        alt={`${name} preview`}
        loading="lazy"
        onError={() => setFailed(true)}
        sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
    )
  }

  return <Typography level="h4">{isDir ? '📁' : isPrintable ? '🧊' : '📄'}</Typography>
}
