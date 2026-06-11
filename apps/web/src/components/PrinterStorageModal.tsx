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
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert, Box, Button, Checkbox, DialogActions, Dropdown, FormControl, FormLabel, IconButton, LinearProgress, Menu, MenuButton, MenuItem,
  ModalClose, Option, Select, Stack, Tooltip, Typography
} from '@mui/joy'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import EditRoundedIcon from '@mui/icons-material/EditRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import PrintRoundedIcon from '@mui/icons-material/PrintRounded'
import {
  deleteOperationResponseSchema,
  extractErrorMessage,
  findFilamentCompatibilityIssues,
  formatNozzleLabel,
  getPrinterPrintOptionCapabilities,
  isDirectPrintableFileName,
  startPrinterStorageDeleteJobSchema,
  trayCanSatisfyRequirement,
  type FilamentCompatibilityIssue,
  type PrintNozzleOffsetCalibrationMode,
  type PrintOnOffAutoMode,
  type PrinterModel,
  type PrinterStatus,
  type PrinterStorageList,
  type PrinterTrayMapping,
  type ThreeMfIndex,
  type ThreeMfProjectFilament
} from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { buildApiUrl } from '../lib/apiUrl'
import { useAuthBootstrapQuery } from '../lib/authQuery'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from '../lib/workspaceScope'
import { useElementVisibility } from '../hooks/useElementVisibility'
import { useLocalStorageState } from '../hooks/useLocalStorageState'
import { useMobileViewport } from './useMobileViewport'
import {
  buildPrintStartPreferenceKey,
  DEFAULT_STORED_PRINT_START_OPTIONS,
  parseStoredPrintStartOptions,
  resolvePrintStartPreferenceDefaults
} from '../lib/printStartOptions'
import { splitLibraryFileNameForRename } from '../lib/libraryDisplay'
import { formatDateTime } from '../lib/time'
import { toast } from '../lib/toast'
import { BackAwareModal as Modal } from './BackAwareModal'
import { DialogSection } from './DialogSection'
import { OverflowTooltipText } from './OverflowTooltipText'
import { usePromptDialog } from './PromptDialogProvider'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'
import { SquareMediaFrame } from './SquareMediaFrame'
import { filamentBackground, filamentTextColor, hasLoadedFilament, resolveFilamentDisplay, resolveProjectFilamentColorName } from '../lib/filamentColor'
import { AmsSpoolSetupDialog, type AmsSpoolSetupTarget } from './AmsSpoolSetupDialog'
import { getSlotRemainingState } from '../lib/slotRemaining'

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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
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
                            : `${formatSize(entry.sizeBytes)}${entry.modifiedAt ? ` · ${formatDateTime(entry.modifiedAt)}` : ''}`
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

function StoragePrintModal({
  printerId,
  printerModel,
  filePath,
  submitting,
  error,
  onSubmit,
  onCancel
}: {
  printerId: string
  printerModel: PrinterModel
  filePath: string
  submitting: boolean
  error: string | null
  onSubmit: (opts: {
    plate: number
    bedLevel: PrintOnOffAutoMode
    vibrationCompensation: boolean
    flowCalibration: PrintOnOffAutoMode
    timelapse: boolean
    nozzleOffsetCalibration: PrintNozzleOffsetCalibrationMode
    amsMapping?: PrinterTrayMapping[]
    allowIncompatibleFilament: boolean
  }) => void
  onCancel: () => void
}) {
  const [plate, setPlate] = useState(1)
  const [bedLevel, setBedLevel] = useState<PrintOnOffAutoMode>('on')
  const [vibrationCompensation, setVibrationCompensation] = useState(false)
  const [flowCalibration, setFlowCalibration] = useState<PrintOnOffAutoMode>('off')
  const [timelapse, setTimelapse] = useState(false)
  const [nozzleOffsetCalibration, setNozzleOffsetCalibration] = useState<PrintNozzleOffsetCalibrationMode>('auto')
  const [printOptionsTouched, setPrintOptionsTouched] = useState(false)
  const [printOptionsInitialized, setPrintOptionsInitialized] = useState(false)
  const [allowIncompatibleFilament, setAllowIncompatibleFilament] = useState(false)
  const fileName = filePath.split('/').pop() || filePath
  const authBootstrapQuery = useAuthBootstrapQuery()
  const workspaceScopeKey = readCurrentWorkspaceScopeKey()
  const statusQuery = useQuery<Record<string, PrinterStatus>>({
    queryKey: workspaceQueryKeys.printerStatus(workspaceScopeKey),
    queryFn: () => Promise.resolve({}),
    initialData: {},
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  })
  const statuses = useMemo(() => statusQuery.data ?? {}, [statusQuery.data])
  const status = statuses[printerId]
  const optionCapabilities = useMemo(
    () => getPrinterPrintOptionCapabilities(
      printerModel,
      status
        ? {
            printOptions: status.printOptions,
            printStartOptions: status.printStartOptions
          }
        : null
    ),
    [printerModel, status]
  )
  const storedPrintOptionsKey = useMemo(
    () => buildPrintStartPreferenceKey(authBootstrapQuery.data, [printerModel]),
    [authBootstrapQuery.data, printerModel]
  )
  const [storedPrintOptions, setStoredPrintOptions, storedPrintOptionsReady] = useLocalStorageState(
    storedPrintOptionsKey,
    DEFAULT_STORED_PRINT_START_OPTIONS,
    parseStoredPrintStartOptions
  )
  const resolvedStoredPrintOptions = useMemo(
    () => resolvePrintStartPreferenceDefaults(storedPrintOptions),
    [storedPrintOptions]
  )
  const platesQuery = useQuery({
    queryKey: ['printer-storage-plates', printerId, filePath],
    queryFn: ({ signal }) =>
      apiFetch<ThreeMfIndex>(
        `/api/printers/${printerId}/storage/plates?path=${encodeURIComponent(filePath)}`,
        { signal }
      ),
    enabled: /\.3mf$/i.test(fileName),
    staleTime: 60_000
  })
  const plates = useMemo(() => platesQuery.data?.plates ?? [], [platesQuery.data])
  const projectFilaments = useMemo(() => platesQuery.data?.projectFilaments ?? [], [platesQuery.data])
  const activePlate = useMemo(
    () => plates.find((entry) => entry.index === plate) ?? plates[0],
    [plates, plate]
  )
  const filamentEntries = useMemo<ThreeMfProjectFilament[]>(() => {
    if (projectFilaments.length > 0) return projectFilaments
    return (activePlate?.filaments ?? []).map((filament) => ({
      id: filament.id,
      filamentType: filament.filamentType,
      filamentName: filament.filamentName,
      color: filament.color,
      nozzleId: filament.nozzleId ?? null,
      chamberTemperature: filament.chamberTemperature ?? null
    }))
  }, [projectFilaments, activePlate])
  const usedIds = useMemo(
    () => new Set((activePlate?.filaments ?? []).map((filament) => filament.id)),
    [activePlate]
  )
  const usedGramsById = useMemo(() => {
    const map = new Map<number, number>()
    for (const filament of activePlate?.filaments ?? []) {
      if (filament.usedGrams != null) map.set(filament.id, filament.usedGrams)
    }
    return map
  }, [activePlate])
  const visibleFilaments = useMemo(
    () => filamentEntries.filter((filament) => usedIds.size === 0 || usedIds.has(filament.id)),
    [filamentEntries, usedIds]
  )
  const trayGroups = useMemo(() => buildStorageTrayGroups(status), [status])
  const trayByMappingValue = useMemo(
    () => new Map(trayGroups.flatMap((group) => group.trays.map((tray) => [tray.mappingValue, tray] as const))),
    [trayGroups]
  )
  const [mappings, setMappings] = useState<number[]>([])

  useEffect(() => {
    setMappings(buildDefaultStorageMapping(visibleFilaments, trayGroups))
  }, [filePath, plate, trayGroups, visibleFilaments])

  const mappingCapable = trayGroups.length > 0 && visibleFilaments.length > 0
  const mappedCompatibilityIssues = useMemo(
    () => getStorageMappedCompatibilityIssues(visibleFilaments, trayByMappingValue, mappings),
    [mappings, trayByMappingValue, visibleFilaments]
  )
  const automaticCompatibilityIssues = useMemo(
    () => getStorageAutomaticCompatibilityIssues(activePlate, status),
    [activePlate, status]
  )
  const hardCompatibilityIssues = useMemo(
    () => mappedCompatibilityIssues.filter((issue) => issue.nozzleMismatch),
    [mappedCompatibilityIssues]
  )
  const softCompatibilityIssues = useMemo(
    () => mappedCompatibilityIssues.filter((issue) => issue.typeMismatch && !issue.nozzleMismatch),
    [mappedCompatibilityIssues]
  )
  const selectedTrayWarnings = useMemo(
    () => getStorageSelectedTrayWarnings({ mappings, trayByMappingValue, visibleFilaments, timelapse, status }),
    [mappings, status, timelapse, trayByMappingValue, visibleFilaments]
  )
  const allMappingsComplete = useMemo(() => {
    if (!mappingCapable) return true
    return visibleFilaments.every((filament) => {
      const selectedValue = mappings[filament.id - 1] ?? -1
      if (selectedValue < 0) return false
      const allowedValues = new Set(
        filterStorageTrayGroupsForFilament(trayGroups, filament.nozzleId ?? null)
          .flatMap((group) => group.trays)
          .map((tray) => tray.mappingValue)
      )
      return allowedValues.has(selectedValue)
    })
  }, [mappingCapable, mappings, trayGroups, visibleFilaments])
  const issueSignature = useMemo(
    () => JSON.stringify({ mappedCompatibilityIssues, automaticCompatibilityIssues }),
    [automaticCompatibilityIssues, mappedCompatibilityIssues]
  )
  const hasPrintSettings =
    optionCapabilities.timelapse
    || optionCapabilities.bedLevel
    || optionCapabilities.vibrationCompensation
    || optionCapabilities.flowCalibration
    || optionCapabilities.nozzleOffsetCalibration
  const showCompatibilitySection =
    platesQuery.isLoading
    || selectedTrayWarnings.length > 0
    || (mappingCapable && hardCompatibilityIssues.length > 0)
    || (mappingCapable && softCompatibilityIssues.length > 0)
    || (!mappingCapable && automaticCompatibilityIssues.length > 0)
    || error != null

  useEffect(() => {
    setAllowIncompatibleFilament(false)
  }, [filePath, issueSignature])

  useEffect(() => {
    if (printOptionsTouched) return
    if (!storedPrintOptionsReady) return
    if (printOptionsInitialized) return
    setBedLevel(resolvedStoredPrintOptions.bedLevel)
    setVibrationCompensation(resolvedStoredPrintOptions.vibrationCompensation)
    setFlowCalibration(resolvedStoredPrintOptions.flowCalibration)
    setTimelapse(resolvedStoredPrintOptions.timelapse)
    setNozzleOffsetCalibration(resolvedStoredPrintOptions.nozzleOffsetCalibration)
    setPrintOptionsInitialized(true)
  }, [printOptionsInitialized, printOptionsTouched, resolvedStoredPrintOptions, storedPrintOptionsReady])

  useEffect(() => {
    if (!storedPrintOptionsReady) return
    if (!printOptionsInitialized && !printOptionsTouched) return
    setStoredPrintOptions({
      bedLevel,
      vibrationCompensation,
      flowCalibration,
      timelapse,
      nozzleOffsetCalibration
    })
  }, [
    bedLevel,
    vibrationCompensation,
    flowCalibration,
    nozzleOffsetCalibration,
    printOptionsInitialized,
    printOptionsTouched,
    setStoredPrintOptions,
    storedPrintOptionsReady,
    timelapse
  ])

  const updateBedLevel = (value: PrintOnOffAutoMode) => {
    setPrintOptionsTouched(true)
    setBedLevel(value)
  }

  const updateVibrationCompensation = (value: boolean) => {
    setPrintOptionsTouched(true)
    setVibrationCompensation(value)
  }

  const updateFlowCalibration = (value: PrintOnOffAutoMode) => {
    setPrintOptionsTouched(true)
    setFlowCalibration(value)
  }

  const updateTimelapse = (value: boolean) => {
    setPrintOptionsTouched(true)
    setTimelapse(value)
  }

  const updateNozzleOffsetCalibration = (value: PrintNozzleOffsetCalibrationMode) => {
    setPrintOptionsTouched(true)
    setNozzleOffsetCalibration(value)
  }

  return (
    <Modal open onClose={onCancel}>
      <ScrollableModalDialog sx={{ width: { xs: '96vw', sm: 560 }, maxWidth: '100%' }}>
        <Typography level="h4">Send to printer</Typography>
        <Typography level="body-sm" textColor="text.tertiary" sx={{ mb: 1 }} noWrap>
          {fileName}
        </Typography>
        <ScrollableDialogBody>
        <Stack spacing={2}>
          {plates.length > 1 && (
            <DialogSection title="Plate">
              <FormControl>
                <FormLabel>Plate</FormLabel>
                <Select value={plate} onChange={(_event, value) => value && setPlate(value)}>
                  {plates.map((entry) => (
                    <Option key={entry.index} value={entry.index}>
                      {entry.name?.trim() || `Plate ${entry.index}`}
                    </Option>
                  ))}
                </Select>
              </FormControl>
            </DialogSection>
          )}
          {mappingCapable && (
            <DialogSection title="Filament mapping">
              <StoragePrinterMapping
                printerId={printerId}
                status={status}
                filaments={filamentEntries}
                usedIds={usedIds}
                usedGramsById={usedGramsById}
                trayGroups={trayGroups}
                mapping={mappings}
                issues={mappedCompatibilityIssues}
                onChange={(filamentId, tray) => {
                  setMappings((current) => {
                    const updated = [...current]
                    while (updated.length <= filamentId - 1) updated.push(-1)
                    updated[filamentId - 1] = tray
                    return updated
                  })
                }}
              />
            </DialogSection>
          )}
          {hasPrintSettings && (
            <DialogSection title="Print settings">
              <Stack spacing={1.25}>
                {optionCapabilities.timelapse && (
                  <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
                    <FormLabel>Timelapse</FormLabel>
                    <Select<'off' | 'on'> value={timelapse ? 'on' : 'off'} onChange={(_event, value) => value && updateTimelapse(value === 'on')}>
                      <Option value="off">Off</Option>
                      <Option value="on">On</Option>
                    </Select>
                  </FormControl>
                )}
                {optionCapabilities.bedLevel && (
                  <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
                    <FormLabel>Auto Bed Leveling</FormLabel>
                    <Select<PrintOnOffAutoMode> value={bedLevel} onChange={(_event, value) => value && updateBedLevel(value)}>
                      <Option value="off">Off</Option>
                      <Option value="on">On</Option>
                      {optionCapabilities.bedLevelAuto && <Option value="auto">Auto</Option>}
                    </Select>
                  </FormControl>
                )}
                {optionCapabilities.vibrationCompensation && (
                  <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
                    <FormLabel>Vibration Compensation</FormLabel>
                    <Select<'off' | 'on'> value={vibrationCompensation ? 'on' : 'off'} onChange={(_event, value) => value && updateVibrationCompensation(value === 'on')}>
                      <Option value="off">Off</Option>
                      <Option value="on">On</Option>
                    </Select>
                  </FormControl>
                )}
                {optionCapabilities.flowCalibration && (
                  <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
                    <FormLabel>Flow Dynamics Calibration</FormLabel>
                    <Select<PrintOnOffAutoMode> value={flowCalibration} onChange={(_event, value) => value && updateFlowCalibration(value)}>
                      <Option value="off">Off</Option>
                      <Option value="on">On</Option>
                      {optionCapabilities.flowCalibrationAuto && <Option value="auto">Auto</Option>}
                    </Select>
                  </FormControl>
                )}
                {optionCapabilities.nozzleOffsetCalibration && (
                  <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
                    <FormLabel>Nozzle Offset Calibration</FormLabel>
                    <Select<PrintNozzleOffsetCalibrationMode>
                      value={nozzleOffsetCalibration}
                      onChange={(_event, value) => value && updateNozzleOffsetCalibration(value)}
                    >
                      <Option value="off">Off</Option>
                      <Option value="on">On</Option>
                      <Option value="auto">Auto</Option>
                    </Select>
                  </FormControl>
                )}
              </Stack>
            </DialogSection>
          )}
          {showCompatibilitySection && (
            <DialogSection title="Readiness">
              <Stack spacing={1.25}>
                {platesQuery.isLoading && (
                  <Typography level="body-xs" textColor="text.tertiary">
                    Reading print metadata…
                  </Typography>
                )}
                {selectedTrayWarnings.length > 0 && (
                  <Alert color="warning" variant="soft">
                    <Stack spacing={0.5}>
                      {selectedTrayWarnings.map((warning) => (
                        <Typography key={warning} level="body-xs">{warning}</Typography>
                      ))}
                    </Stack>
                  </Alert>
                )}
                {mappingCapable && hardCompatibilityIssues.length > 0 && (
                  <Alert color="danger" variant="soft">
                    <Stack spacing={1}>
                      <Typography level="title-sm">Tray assignment must be fixed</Typography>
                      {hardCompatibilityIssues.map((issue) => (
                        <Typography key={issue.filamentId} level="body-xs">
                          {formatStorageMappedCompatibilityIssue(issue, status?.nozzles.length ?? null)}
                        </Typography>
                      ))}
                    </Stack>
                  </Alert>
                )}
                {mappingCapable && softCompatibilityIssues.length > 0 && (
                  <Alert color="warning" variant="soft">
                    <Stack spacing={1}>
                      <Typography level="title-sm">Filament mismatch detected</Typography>
                      {softCompatibilityIssues.map((issue) => (
                        <Typography key={issue.filamentId} level="body-xs">
                          {formatStorageMappedCompatibilityIssue(issue, status?.nozzles.length ?? null)}
                        </Typography>
                      ))}
                      <Checkbox
                        label="Print anyway with the current tray assignments"
                        checked={allowIncompatibleFilament}
                        onChange={(event) => setAllowIncompatibleFilament(event.target.checked)}
                      />
                    </Stack>
                  </Alert>
                )}
                {!mappingCapable && automaticCompatibilityIssues.length > 0 && (
                  <Alert color="warning" variant="soft">
                    <Stack spacing={1}>
                      <Typography level="title-sm">Loaded filament may be incompatible</Typography>
                      {automaticCompatibilityIssues.map((issue) => (
                        <Typography key={issue.filamentId} level="body-xs">
                          {formatStorageAutomaticCompatibilityIssue(issue, status?.nozzles.length ?? null)}
                        </Typography>
                      ))}
                      <Checkbox
                        label="Print anyway with the currently loaded filament"
                        checked={allowIncompatibleFilament}
                        onChange={(event) => setAllowIncompatibleFilament(event.target.checked)}
                      />
                    </Stack>
                  </Alert>
                )}
                {error && (
                  <Typography level="body-sm" color="danger">{error}</Typography>
                )}
              </Stack>
            </DialogSection>
          )}
        </Stack>
        </ScrollableDialogBody>
        <DialogActions sx={{ pt: 1 }}>
          <Button variant="plain" onClick={onCancel} disabled={submitting}>Cancel</Button>
          <Button
            onClick={() => onSubmit({
              plate,
              bedLevel,
              vibrationCompensation,
              flowCalibration,
              timelapse,
              nozzleOffsetCalibration,
              amsMapping: sanitizeStorageMapping(mappings),
              allowIncompatibleFilament
            })}
            loading={submitting}
            disabled={
              (mappingCapable && !allMappingsComplete)
              || hardCompatibilityIssues.length > 0
              || (softCompatibilityIssues.length > 0 && !allowIncompatibleFilament)
              || (!mappingCapable && automaticCompatibilityIssues.length > 0 && !allowIncompatibleFilament)
            }
          >
            Start print
          </Button>
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
  )
}

interface StorageCompatibilityIssue {
  filamentId: number
  filamentType: string | null
  filamentName: string | null
  nozzleId: number | null
}

interface StorageTrayOption {
  mappingValue: PrinterTrayMapping
  key: string
  kind: 'ams' | 'external'
  label: string
  badgeLabel: string
  groupLabel: string
  color: string | null
  colors: string[]
  filamentType: string | null
  trayName: string | null
  trayInfoIdx: string | null
  remainPercent: number | null
  nozzleId: number | null
  active: boolean
  /** Slot reports a physical spool even though its identity is unreadable. */
  occupied?: boolean | null
  /** AMS coordinates for the spool-setup dialog (AMS trays only). */
  amsUnitId?: number
  amsSlotId?: number
}

interface StorageTrayGroup {
  key: string
  label: string
  trays: StorageTrayOption[]
}

function getStorageAutomaticCompatibilityIssues(
  plate: ThreeMfIndex['plates'][number] | undefined,
  status: PrinterStatus | undefined
): StorageCompatibilityIssue[] {
  if (!plate || !status) return []
  const trays = buildStorageTrayCandidates(status)
  return plate.filaments
    .filter((filament) => !trays.some((tray) => trayCanSatisfyRequirement({
      filamentId: filament.id,
      filamentType: filament.filamentType,
      filamentName: filament.filamentName,
      nozzleId: filament.nozzleId
    }, tray)))
    .map((filament) => ({
      filamentId: filament.id,
      filamentType: filament.filamentType,
      filamentName: filament.filamentName,
      nozzleId: filament.nozzleId
    }))
}

function getStorageMappedCompatibilityIssues(
  filaments: ThreeMfProjectFilament[],
  trayByMappingValue: Map<number, StorageTrayOption>,
  mapping: number[]
): FilamentCompatibilityIssue[] {
  const selectedTrays = new Map<number, { filamentType: string | null; label: string; nozzleId: number | null }>()
  for (const filament of filaments) {
    const mappingValue = mapping[filament.id - 1]
    if (typeof mappingValue !== 'number' || mappingValue < 0) continue
    const tray = trayByMappingValue.get(mappingValue)
    if (!tray) continue
    selectedTrays.set(filament.id, {
      filamentType: tray.filamentType,
      label: tray.kind === 'external' ? tray.label : `${tray.groupLabel} ${tray.label}`,
      nozzleId: tray.nozzleId
    })
  }

  return findFilamentCompatibilityIssues(
    filaments.map((filament) => ({
      filamentId: filament.id,
      filamentType: filament.filamentType,
      filamentName: filament.filamentName,
      nozzleId: filament.nozzleId ?? null
    })),
    selectedTrays
  )
}

function buildStorageTrayCandidates(status: PrinterStatus): Array<{ filamentType: string | null; label: string; nozzleId: number | null }> {
  const trays: Array<{ filamentType: string | null; label: string; nozzleId: number | null }> = []
  for (const spool of status.externalSpools) {
    trays.push({
      filamentType: spool.filamentType,
      label: status.externalSpools.length > 1 ? (spool.amsId === 255 ? 'Ext-R' : 'Ext-L') : 'Ext',
      nozzleId: spool.nozzleId
    })
  }
  for (const unit of status.ams) {
    for (const slot of unit.slots) {
      trays.push({
        filamentType: slot.filamentType,
        label: `AMS ${String.fromCharCode(65 + unit.unitId)} Slot ${slot.slot + 1}`,
        nozzleId: null
      })
    }
  }
  return trays
}

function buildStorageTrayGroups(status: PrinterStatus | undefined): StorageTrayGroup[] {
  if (!status) return []
  const groups: StorageTrayGroup[] = []

  if (status.externalSpools.length > 0) {
    groups.push({
      key: 'external',
      label: 'External Spool',
      trays: status.externalSpools.map((spool) => ({
        mappingValue: spool.amsId,
        key: `external-${spool.amsId}`,
        kind: 'external',
        label: status.externalSpools.length > 1 ? (spool.amsId === 255 ? 'Ext-R' : 'Ext-L') : 'Ext',
        badgeLabel: status.externalSpools.length > 1 ? (spool.amsId === 255 ? 'Ext-R' : 'Ext-L') : 'Ext',
        groupLabel: 'External Spool',
        color: spool.color,
        colors: spool.colors,
        filamentType: spool.filamentType,
        trayName: spool.trayName,
        trayInfoIdx: spool.trayInfoIdx,
        remainPercent: spool.remainPercent,
        nozzleId: spool.nozzleId,
        active: spool.active
      }))
    })
  }

  for (const unit of status.ams) {
    const groupLabel = `AMS ${String.fromCharCode(65 + unit.unitId)}`
    groups.push({
      key: `ams-${unit.unitId}`,
      label: groupLabel,
      trays: unit.slots.map((slot) => ({
        mappingValue: unit.unitId * 4 + slot.slot,
        key: `ams-${unit.unitId}-${slot.slot}`,
        kind: 'ams',
        label: `Slot ${slot.slot + 1}`,
        badgeLabel: `${String.fromCharCode(65 + unit.unitId)}${slot.slot + 1}`,
        groupLabel,
        color: slot.color,
        colors: slot.colors,
        filamentType: slot.filamentType,
        trayName: slot.trayName,
        trayInfoIdx: slot.trayInfoIdx,
        remainPercent: slot.remainPercent,
        nozzleId: unit.nozzleId,
        active: slot.active,
        occupied: slot.occupied ?? null,
        amsUnitId: unit.unitId,
        amsSlotId: slot.slot
      }))
    })
  }

  return groups
}

function filterStorageTrayGroupsForFilament(
  groups: StorageTrayGroup[],
  requiredNozzleId: number | null
): StorageTrayGroup[] {
  if (requiredNozzleId == null) return groups
  return groups
    .map((group) => ({
      ...group,
      trays: group.trays.filter((tray) => tray.nozzleId == null || tray.nozzleId === requiredNozzleId)
    }))
    .filter((group) => group.trays.length > 0)
}

function buildDefaultStorageMapping(
  filaments: ThreeMfProjectFilament[],
  trayGroups: StorageTrayGroup[]
): number[] {
  const mapping: number[] = []
  for (const filament of filaments) {
    const allowedTrays = filterStorageTrayGroupsForFilament(trayGroups, filament.nozzleId ?? null)
      .flatMap((group) => group.trays)
      .filter((tray) => trayCanSatisfyRequirement({
        filamentId: filament.id,
        filamentType: filament.filamentType,
        filamentName: filament.filamentName,
        nozzleId: filament.nozzleId ?? null
      }, {
        filamentType: tray.filamentType,
        label: tray.kind === 'external' ? tray.label : `${tray.groupLabel} ${tray.label}`,
        nozzleId: tray.nozzleId
      }))

    const preferred = allowedTrays.find((tray) => tray.active) ?? (allowedTrays.length === 1 ? allowedTrays[0] : null)
    if (!preferred) continue
    while (mapping.length <= filament.id - 1) mapping.push(-1)
    mapping[filament.id - 1] = preferred.mappingValue
  }
  return mapping
}

function sanitizeStorageMapping(mapping: number[] | undefined): PrinterTrayMapping[] | undefined {
  if (!mapping || mapping.length === 0) return undefined
  let lastSet = -1
  for (let i = 0; i < mapping.length; i++) {
    if ((mapping[i] ?? -1) >= 0) lastSet = i
  }
  if (lastSet === -1) return undefined
  return mapping.slice(0, lastSet + 1).map((value) => (value < 0 ? 0 : value as PrinterTrayMapping))
}

function StoragePrinterMapping({
  printerId,
  status,
  filaments,
  usedIds,
  usedGramsById,
  trayGroups,
  mapping,
  issues,
  onChange
}: {
  printerId: string
  status: PrinterStatus | undefined
  filaments: ThreeMfProjectFilament[]
  usedIds: Set<number>
  usedGramsById: Map<number, number>
  trayGroups: StorageTrayGroup[]
  mapping: number[]
  issues: FilamentCompatibilityIssue[]
  onChange: (filamentId: number, tray: number) => void
}) {
  const visible = filaments.filter((filament) => usedIds.size === 0 || usedIds.has(filament.id))
  const trays = useMemo(() => trayGroups.flatMap((group) => group.trays), [trayGroups])
  const nozzleCount = status?.nozzles.length ?? null
  // Spool-setup dialog for unrecognized-but-occupied slots picked in the mapping.
  const [spoolSetupTarget, setSpoolSetupTarget] = useState<AmsSpoolSetupTarget | null>(null)
  const issueByFilamentId = useMemo(
    () => new Map(issues.map((issue) => [issue.filamentId, issue] as const)),
    [issues]
  )

  return (
    <Stack spacing={0.5} sx={{ mt: 0.5 }}>
      {visible.map((filament) => {
        const allowedGroups = filterStorageTrayGroupsForFilament(trayGroups, filament.nozzleId ?? null)
        const allowedTrayByValue = new Map(
          allowedGroups.flatMap((group) => group.trays.map((tray) => [tray.mappingValue, tray] as const))
        )
        const slotIndex = filament.id - 1
        const value = mapping[slotIndex] ?? -1
        const selectedTray = trays.find((tray) => tray.mappingValue === value)
        const selectedUnknownTray = selectedTray && storageTrayHasUnknownSpool(selectedTray) ? selectedTray : null
        const grams = usedGramsById.get(filament.id)
        const colorLabel = resolveProjectFilamentColorName({
          color: filament.color,
          filamentName: filament.filamentName,
          filamentType: filament.filamentType
        })
        const issue = issueByFilamentId.get(filament.id)
        const nozzleLabel = formatNozzleLabel(filament.nozzleId ?? null, 'short', nozzleCount)
        const filamentPrimaryLabel = [
          filament.filamentName ?? filament.filamentType ?? 'filament',
          colorLabel
        ].filter(Boolean).join(' · ')
        const filamentMetaLabel = [
          nozzleLabel,
          grams != null ? `${grams.toFixed(grams < 10 ? 1 : 0)}g` : null
        ].filter(Boolean).join(' · ')

        return (
          <Stack key={filament.id} spacing={0.25}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: '1 1 0', minWidth: 0 }}>
                <Box
                  sx={{
                    width: 32,
                    height: 32,
                    borderRadius: '50%',
                    backgroundColor: filament.color ?? 'var(--joy-palette-neutral-700)',
                    border: '1px solid var(--joy-palette-neutral-700)',
                    flexShrink: 0,
                    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)'
                  }}
                />
                <Stack spacing={0} sx={{ minWidth: 0, flex: '1 1 0' }}>
                  <OverflowTooltipText
                    level="body-xs"
                    sx={{ minWidth: 0 }}
                    noWrap
                    text={filamentPrimaryLabel}
                  />
                  {filamentMetaLabel ? (
                    <OverflowTooltipText
                      level="body-xs"
                      textColor="text.tertiary"
                      sx={{ minWidth: 0 }}
                      noWrap
                      text={filamentMetaLabel}
                    />
                  ) : null}
                </Stack>
              </Stack>
              <Select<number>
                size="sm"
                value={value === -1 ? null : value}
                placeholder="Choose slot…"
                color={value === -1 || issue ? 'warning' : 'neutral'}
                onChange={(_event, next) => next != null && onChange(filament.id, next)}
                renderValue={(option) => {
                  if (!option) return <Typography level="body-xs">Choose slot…</Typography>
                  const tray = allowedTrayByValue.get(option.value as number)
                  if (!tray) return <Typography level="body-xs">Choose slot…</Typography>
                  return (
                    <StorageTrayOptionLabel
                      tray={tray}
                      trays={trays}
                      nozzleCount={nozzleCount}
                      requiredFilamentType={filament.filamentType}
                      requiredNozzleId={filament.nozzleId ?? null}
                      requiredGrams={grams ?? null}
                      autoRefillEnabled={status?.amsSettings.autoRefill === true}
                    />
                  )
                }}
                sx={{ flex: '1 1 0', minWidth: 0 }}
                slotProps={{
                  button: { sx: { textAlign: 'left', justifyContent: 'flex-start', minHeight: 40 } },
                  listbox: {
                    placement: 'bottom-end',
                    modifiers: [{ name: 'equalWidth', enabled: false }],
                    sx: {
                      minWidth: { xs: 'min(92vw, 360px)', sm: 360 },
                      maxWidth: 'calc(100vw - 32px)',
                      width: 'max-content'
                    }
                  }
                }}
              >
                {buildStorageMappingOptionNodes({
                  groups: allowedGroups,
                  trays,
                  nozzleCount,
                  filament,
                  requiredGrams: grams ?? null,
                  autoRefillEnabled: status?.amsSettings.autoRefill === true
                })}
              </Select>
            </Stack>
            {issue && (
              <Typography level="body-xs" color="warning" sx={{ pl: 'calc(32px + 8px)' }}>
                {formatStorageMappedCompatibilityIssue(issue, nozzleCount)}
              </Typography>
            )}
            {selectedUnknownTray && (
              <Stack direction="row" spacing={1} alignItems="center" sx={{ pl: 'calc(32px + 8px)' }}>
                <Typography level="body-xs" color="warning">
                  This slot holds an unrecognized spool.
                </Typography>
                <Button
                  size="sm"
                  variant="plain"
                  sx={{ minHeight: 0, py: 0 }}
                  onClick={() => setSpoolSetupTarget({
                    printerId,
                    kind: selectedUnknownTray.kind,
                    amsId: selectedUnknownTray.kind === 'ams' ? selectedUnknownTray.amsUnitId ?? 0 : selectedUnknownTray.mappingValue,
                    ...(selectedUnknownTray.kind === 'ams' ? { slotId: selectedUnknownTray.amsSlotId ?? 0 } : {}),
                    label: `${selectedUnknownTray.groupLabel} ${selectedUnknownTray.badgeLabel}`,
                    initial: {
                      filamentType: selectedUnknownTray.filamentType,
                      color: selectedUnknownTray.color,
                      trayInfoIdx: selectedUnknownTray.trayInfoIdx
                    }
                  })}
                >
                  Set up spool…
                </Button>
              </Stack>
            )}
          </Stack>
        )
      })}
      {spoolSetupTarget && (
        <AmsSpoolSetupDialog target={spoolSetupTarget} onClose={() => setSpoolSetupTarget(null)} />
      )}
    </Stack>
  )
}

function buildStorageMappingOptionNodes({
  groups,
  trays,
  nozzleCount,
  filament,
  requiredGrams,
  autoRefillEnabled
}: {
  groups: StorageTrayGroup[]
  trays: StorageTrayOption[]
  nozzleCount: number | null
  filament: ThreeMfProjectFilament
  requiredGrams: number | null
  autoRefillEnabled: boolean
}): ReactNode[] {
  const nodes: ReactNode[] = []
  for (const group of groups) {
    nodes.push(
      <Typography
        key={`header-${filament.id}-${group.key}`}
        level="body-xs"
        textColor="text.tertiary"
        sx={{ px: 1, pt: 0.5, pb: 0.25, fontWeight: 'lg', textTransform: 'uppercase', letterSpacing: '0.05em' }}
      >
        {group.label}
      </Typography>
    )
    for (const tray of group.trays) {
      nodes.push(
        <Option key={`${filament.id}-${tray.key}`} value={tray.mappingValue}>
          <StorageTrayOptionLabel
            tray={tray}
            trays={trays}
            nozzleCount={nozzleCount}
            requiredFilamentType={filament.filamentType}
            requiredNozzleId={filament.nozzleId ?? null}
            requiredGrams={requiredGrams}
            autoRefillEnabled={autoRefillEnabled}
          />
        </Option>
      )
    }
  }
  return nodes
}

function StorageTrayOptionLabel({
  tray,
  trays,
  nozzleCount,
  requiredFilamentType,
  requiredNozzleId,
  requiredGrams,
  autoRefillEnabled
}: {
  tray: StorageTrayOption
  trays: readonly StorageTrayOption[]
  nozzleCount?: number | null
  requiredFilamentType?: string | null
  requiredNozzleId?: number | null
  requiredGrams?: number | null
  autoRefillEnabled?: boolean
}) {
  const source = tray.kind === 'external' ? tray.label : `${tray.groupLabel} ${tray.label}`
  const hasFilament = storageTrayHasLoadedFilament(tray)
  const unknownSpool = storageTrayHasUnknownSpool(tray)
  const filament = resolveFilamentDisplay(tray)
  const brandLabel = filament.material ? `Bambu ${filament.material}` : tray.filamentType
  const filamentDetail = unknownSpool
    ? 'Unknown spool'
    : [brandLabel ?? 'Empty', filament.name].filter(Boolean).join(' · ')
  const remainingState = getSlotRemainingState({
    tray,
    trays,
    requiredFilamentType,
    requiredNozzleId,
    requiredGrams,
    autoRefillEnabled
  })
  const badgeBackground = filamentBackground(filament.colors, tray.color, 'var(--joy-palette-neutral-800)')
  const badgeForeground = filamentTextColor(filament.colors, tray.color, 'var(--joy-palette-text-primary)')
  const remainGrams = remainingState.remainGrams
  const remainingDetail = hasFilament && tray.remainPercent != null && remainGrams != null
    ? `${Math.round(tray.remainPercent)}% (~${remainGrams}g)`
    : null
  const typeMismatch = Boolean(
    requiredFilamentType
    && tray.filamentType
    && findFilamentCompatibilityIssues(
      [{ filamentId: 1, filamentType: requiredFilamentType, filamentName: null, nozzleId: requiredNozzleId ?? null }],
      new Map([[1, { filamentType: tray.filamentType, label: tray.label, nozzleId: tray.nozzleId }]])
    )[0]?.typeMismatch
  )
  const nozzleMismatch = Boolean(
    requiredNozzleId != null
    && (tray.nozzleId == null || requiredNozzleId !== tray.nozzleId)
  )
  const incompatibilityLabel = typeMismatch
    ? `Incompatible material: requires ${requiredFilamentType ?? 'the selected material'}${tray.filamentType ? `, slot has ${tray.filamentType}` : ''}.`
    : nozzleMismatch
      ? `Incompatible nozzle: requires ${formatNozzleLabel(requiredNozzleId ?? null, 'short', nozzleCount) ?? 'the target nozzle'}${tray.nozzleId != null ? `, slot is ${formatNozzleLabel(tray.nozzleId, 'short', nozzleCount)}` : ''}.`
      : null

  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%', minWidth: 0 }}>
      <Box
        sx={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          border: '1px solid var(--joy-palette-neutral-700)',
          background: badgeBackground,
          color: badgeForeground,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '0.7rem',
          fontWeight: 'lg',
          lineHeight: 1,
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)'
        }}
      >
        {tray.badgeLabel}
      </Box>
      <Box
        sx={{
          minWidth: 0,
          flex: 1,
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto',
          columnGap: 1,
          rowGap: 0.125
        }}
      >
        <Typography level="body-xs" textColor="text.primary" noWrap sx={{ minWidth: 0, gridColumn: '1 / 2' }}>
          {source}
        </Typography>
        <Typography level="body-xs" textColor={unknownSpool ? 'warning.300' : 'text.tertiary'} noWrap sx={{ minWidth: 0, gridColumn: '1 / 2' }}>
          {filamentDetail || 'No filament reported'}
        </Typography>
        {incompatibilityLabel && (
          <StorageIncompatibilityWarningGlyph label={incompatibilityLabel} />
        )}
        {remainingDetail && (
          <Stack direction="row" spacing={0.5} alignItems="center" sx={{ gridColumn: '1 / 2', minWidth: 0 }}>
            <Typography
              level="body-xs"
              textColor={remainingState.insufficient ? 'danger.plainColor' : 'text.primary'}
              noWrap
              sx={{ minWidth: 0, fontWeight: remainingState.insufficient ? 'md' : undefined }}
            >
              {remainingDetail}
            </Typography>
            {remainingState.usesAutoRefill && (
              <Tooltip title="AMS auto-refill can continue this filament from another matching AMS slot." variant="soft" size="sm">
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', color: 'primary.plainColor', flexShrink: 0 }}>
                  <StorageAutoRefillGlyph />
                </Box>
              </Tooltip>
            )}
          </Stack>
        )}
      </Box>
    </Stack>
  )
}

function StorageIncompatibilityWarningGlyph({ label }: { label: string }) {
  return (
    <Tooltip title={label} variant="soft" size="sm">
      <Box
        component="span"
        aria-label={label}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          color: 'warning.plainColor',
          flexShrink: 0,
          gridColumn: '2 / 3',
          gridRow: '1 / span 2',
          alignSelf: 'center',
          justifySelf: 'end',
          cursor: 'help'
        }}
      >
        <StorageWarningGlyph />
      </Box>
    </Tooltip>
  )
}

function StorageAutoRefillGlyph() {
  return (
    <Box component="svg" viewBox="0 0 24 24" aria-hidden sx={{ width: 14, height: 14, display: 'block', fill: 'currentColor' }}>
      <path d="M12 5a7 7 0 0 1 6.42 4.22H16v2h6V5h-2v2.38A9 9 0 0 0 3 12h2a7 7 0 0 1 7-7zm7 6a7 7 0 0 1-13.42 2.78H8v-2H2v6h2v-2.38A9 9 0 0 0 21 12h-2a7 7 0 0 1-7 7z" />
    </Box>
  )
}

function StorageWarningGlyph() {
  return (
    <Box component="svg" viewBox="0 0 24 24" aria-hidden sx={{ width: 14, height: 14, display: 'block', fill: 'currentColor' }}>
      <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
    </Box>
  )
}

function storageTrayHasLoadedFilament(tray: Pick<StorageTrayOption, 'filamentType' | 'color' | 'colors' | 'trayInfoIdx' | 'trayName'>): boolean {
  return hasLoadedFilament(tray.filamentType, tray.color, tray.colors, {
    trayInfoIdx: tray.trayInfoIdx,
    trayName: tray.trayName
  })
}

/** Spool physically present but unidentified — must not read as "Empty". */
function storageTrayHasUnknownSpool(tray: Pick<StorageTrayOption, 'filamentType' | 'color' | 'colors' | 'trayInfoIdx' | 'trayName' | 'occupied'>): boolean {
  return !storageTrayHasLoadedFilament(tray) && tray.occupied === true
}

function getStorageSelectedTrayWarnings(input: {
  mappings: number[]
  trayByMappingValue: Map<number, StorageTrayOption>
  visibleFilaments: ThreeMfProjectFilament[]
  timelapse: boolean
  status: PrinterStatus | undefined
}): string[] {
  const warnings = new Set<string>()
  let hasAms = false
  let hasExternal = false

  for (const filament of input.visibleFilaments) {
    const mappingValue = input.mappings[filament.id - 1]
    if (typeof mappingValue !== 'number' || mappingValue < 0) continue
    const tray = input.trayByMappingValue.get(mappingValue)
    if (!tray) continue
    hasAms = hasAms || tray.kind === 'ams'
    hasExternal = hasExternal || tray.kind === 'external'
    if (!tray.filamentType && !tray.trayInfoIdx) {
      warnings.add('One or more selected trays have unknown filament details. Check the printer before starting the print.')
    }
  }

  if (hasAms && hasExternal) {
    warnings.add('This tray assignment mixes AMS slots and external spools. Review the mapping before printing.')
  }
  if (input.timelapse && input.status?.sdCardPresent === false) {
    warnings.add('Timelapse is enabled, but the printer reports no SD card.')
  }

  return Array.from(warnings)
}

function formatStorageAutomaticCompatibilityIssue(issue: StorageCompatibilityIssue, nozzleCount?: number | null): string {
  const subject = `#${issue.filamentId} ${issue.filamentName ?? issue.filamentType ?? 'filament'}`
  const nozzle = formatNozzleLabel(issue.nozzleId, 'long', nozzleCount)
  return nozzle
    ? `${subject}: no compatible loaded tray was found for the ${nozzle}`
    : `${subject}: no compatible loaded tray was found`
}

function formatStorageMappedCompatibilityIssue(issue: FilamentCompatibilityIssue, nozzleCount?: number | null): string {
  const subject = `#${issue.filamentId} ${issue.requiredFilamentName ?? issue.requiredFilamentType ?? 'filament'}`
  const trayLabel = issue.trayLabel ?? 'selected tray'
  const parts: string[] = []

  if (issue.typeMismatch) {
    parts.push(`${trayLabel} has ${issue.selectedFilamentType ?? 'an unknown material'}, expected ${issue.requiredFilamentType ?? 'the sliced material'}`)
  }
  if (issue.nozzleMismatch) {
    parts.push(`${trayLabel} feeds ${formatNozzleLabel(issue.trayNozzleId, 'long', nozzleCount) ?? 'the wrong nozzle'}, expected ${formatNozzleLabel(issue.nozzleId, 'long', nozzleCount) ?? 'the target nozzle'}`)
  }

  return `${subject}: ${parts.join('; ')}`
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
