/**
 * Firmware-updates plugin (built-in, web side).
 *
 * Surfaces firmware-update awareness directly on the printer card:
 *
 * - Renders an "Update" Chip in the `printer.card.headerChips` slot
 *   when the printer's installed firmware is older than the latest
 *   version published by Bambu Lab. The chip is the only thing the
 *   plugin contributes to the core layout — the card is unchanged
 *   when no update is available, and uninstalling the plugin removes
 *   the chip without touching anything else.
 * - Clicking the chip or choosing "Firmware updates..." from the
 *   printer-card kebab menu opens a dialog with version details,
 *   release notes, an SD-card precondition warning, and the
 *   "Upload to SD card" action. Live progress (download + FTPS
 *   upload) is delivered over the shared `plugin.event` WebSocket
 *   envelope so the dialog stays responsive without polling.
 *
 * The actual flash still has to be triggered from the printer's
 * screen (Settings > Firmware) — Bambu does not expose a remote
 * trigger, even on LAN.
 */
/* eslint-disable react-refresh/only-export-components -- plugin entry exports a component intentionally */
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormLabel,
  Link,
  LinearProgress,
  MenuItem,
  ModalDialog,
  Option,
  Select,
  Stack,
  Typography
} from '@mui/joy'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  PRINTERS_MANAGE_PERMISSION,
  PRINTERS_VIEW_PERMISSION
} from '@printstream/shared'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { WebPlugin } from '../../plugin/types'
import { apiFetch } from '../../lib/apiClient'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { wsClient } from '../../lib/wsClient'
import { BackAwareModal as Modal } from '../../components/BackAwareModal'
import {
  firmwareChipColor,
  firmwareStillPendingInstall,
  formatFirmwareChipLabel,
  getDefaultSelectedVersion,
  getInstallableVersions,
  getSelectedReleaseNotes,
  isActiveUploadStatus,
  isDowngradeSelection,
  isInstallableVersionSelected,
  isUploadedVersionLatest,
  parseFirmwareStatusEvent,
  parseUploadProgressEvent,
  readStoredUpdates,
  shouldInvalidateFirmwareUpdates,
  shouldPollUploadProgress,
  shouldShowFirmwareUpdateChip,
  writeStoredUpdates,
  type FirmwareStatusSnapshot,
  type UpdatesResponse,
  type UploadProgress
} from './state'

const UPDATES_QUERY_KEY_PREFIX = ['firmware-updates', 'updates'] as const
const UPLOAD_QUERY_KEY_PREFIX = ['firmware-updates', 'upload'] as const
const firmwareDialogOpenListeners = new Map<string, Set<() => void>>()

function updatesQueryKey(scopeKey: string) {
  return [...UPDATES_QUERY_KEY_PREFIX, scopeKey] as const
}

function requestFirmwareDialogOpen(printerId: string): void {
  for (const listener of firmwareDialogOpenListeners.get(printerId) ?? []) {
    listener()
  }
}

function subscribeToFirmwareDialogOpen(printerId: string, listener: () => void): () => void {
  const listeners = firmwareDialogOpenListeners.get(printerId) ?? new Set<() => void>()
  listeners.add(listener)
  firmwareDialogOpenListeners.set(printerId, listeners)
  return () => {
    const current = firmwareDialogOpenListeners.get(printerId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) {
      firmwareDialogOpenListeners.delete(printerId)
    }
  }
}

/**
 * Subscribes to the shared WebSocket and routes `firmware-updates`
 * upload-progress envelopes into the TanStack Query cache, keyed per
 * printer. Mounted from each open dialog; `wsClient` is reference
 * counted so multiple subscribers share one socket.
 */
function useFirmwareProgressSync(): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    wsClient.start()
    const off = wsClient.onJson((raw) => {
      const progress = parseUploadProgressEvent(raw)
      if (!progress) return
      queryClient.setQueryData<UploadProgress>(
        [...UPLOAD_QUERY_KEY_PREFIX, progress.printerId],
        progress
      )
    })
    return () => {
      off()
      wsClient.stop()
    }
  }, [queryClient])
}

function useFirmwareUpdatesInvalidation(printerId: string): void {
  const queryClient = useQueryClient()
  const lastStatusRef = useRef<FirmwareStatusSnapshot | undefined>(undefined)

  useEffect(() => {
    wsClient.start()
    const off = wsClient.onJson((raw) => {
      const status = parseFirmwareStatusEvent(raw)
      if (!status || status.printerId !== printerId) return

      const shouldInvalidate = shouldInvalidateFirmwareUpdates(lastStatusRef.current, status)
      lastStatusRef.current = status
      if (!shouldInvalidate) return

      void queryClient.invalidateQueries({ queryKey: UPDATES_QUERY_KEY_PREFIX })
    })
    return () => {
      off()
      wsClient.stop()
    }
  }, [printerId, queryClient])
}

function useUpdatesQuery(scopeKey: string | null) {
  const query = useQuery<UpdatesResponse>({
    queryKey: scopeKey ? updatesQueryKey(scopeKey) : [...UPDATES_QUERY_KEY_PREFIX, 'pending'],
    queryFn: () => apiFetch<UpdatesResponse>('/api/plugins/firmware-updates/updates'),
    enabled: Boolean(scopeKey),
    initialData: scopeKey ? () => readStoredUpdates(scopeKey) : undefined,
    staleTime: 5 * 60_000
  })
  useEffect(() => {
    if (scopeKey && query.data) writeStoredUpdates(scopeKey, query.data)
  }, [query.data, scopeKey])
  return query
}

function useFirmwarePermissions(): { canViewPrinters: boolean; canManagePrinters: boolean; loading: boolean; scopeKey: string | null } {
  const authBootstrapQuery = useAuthBootstrapQuery()
  const authEnabled = authBootstrapQuery.data?.authEnabled ?? false
  const permissions = authBootstrapQuery.data?.permissions ?? []

  return {
    canViewPrinters: authBootstrapQuery.data ? (!authEnabled || permissions.includes(PRINTERS_VIEW_PERMISSION)) : false,
    canManagePrinters: authBootstrapQuery.data ? (!authEnabled || permissions.includes(PRINTERS_MANAGE_PERMISSION)) : false,
    loading: authBootstrapQuery.isLoading,
    scopeKey: authBootstrapQuery.data ? authBootstrapQuery.data.tenant?.id ?? 'platform' : null
  }
}

function useUploadProgress(printerId: string): UploadProgress | undefined {
  const query = useQuery<UploadProgress | undefined>({
    queryKey: [...UPLOAD_QUERY_KEY_PREFIX, printerId],
    // Hydrate from the polling endpoint once on mount so a dialog
    // opened while an upload is already running picks up the live state.
    queryFn: ({ signal }) => apiFetch<UploadProgress>(`/api/plugins/firmware-updates/updates/${printerId}/upload/status`, { signal }),
    staleTime: Infinity,
    refetchInterval: (query) => {
      return shouldPollUploadProgress(query.state.data) ? 2_000 : false
    }
  })
  return query.data
}

function FirmwareReleaseNotes({ markdown }: { markdown: string }) {
  return (
    <Box
      sx={{
        maxHeight: 220,
        overflow: 'auto',
        px: 1.25,
        py: 1,
        borderRadius: 'sm',
        backgroundColor: 'background.level1',
        border: '1px solid',
        borderColor: 'divider',
        '& > :first-child': { mt: 0 },
        '& > :last-child': { mb: 0 },
        '& p': { my: 0.75 },
        '& ul, & ol': { my: 0.75, pl: 3 },
        '& li + li': { mt: 0.375 },
        '& h1, & h2, & h3, & h4': { mt: 1.25, mb: 0.5, fontSize: 'md', fontWeight: 'lg' },
        '& code': {
          px: 0.375,
          py: 0.125,
          borderRadius: 'xs',
          fontFamily: 'monospace',
          fontSize: '0.85em',
          backgroundColor: 'background.level2'
        },
        '& pre': {
          my: 1,
          p: 1,
          borderRadius: 'sm',
          overflow: 'auto',
          backgroundColor: 'background.level2'
        },
        '& pre code': {
          p: 0,
          backgroundColor: 'transparent'
        },
        '& blockquote': {
          my: 1,
          pl: 1.25,
          borderLeft: '3px solid',
          borderColor: 'neutral.outlinedBorder',
          color: 'text.secondary'
        },
        '& hr': {
          my: 1.25,
          border: 'none',
          borderTop: '1px solid',
          borderColor: 'divider'
        },
        '& table': {
          width: '100%',
          my: 1,
          borderCollapse: 'collapse'
        },
        '& th, & td': {
          p: 0.5,
          border: '1px solid',
          borderColor: 'divider',
          textAlign: 'left'
        }
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, children, href, title }) => (
            <Link href={href} title={title} target="_blank" rel="noreferrer">
              {children}
            </Link>
          )
        }}
      >
        {markdown}
      </ReactMarkdown>
    </Box>
  )
}

function FirmwareUpdateDetailsDialog({
  printerId,
  printerName,
  onClose
}: {
  printerId: string
  printerName: string
  onClose: () => void
}) {
  const { canManagePrinters, scopeKey } = useFirmwarePermissions()
  useFirmwareProgressSync()
  const updatesQuery = useUpdatesQuery(scopeKey)
  const update = updatesQuery.data?.updates.find((u) => u.printerId === printerId)
  const progress = useUploadProgress(printerId)
  const queryClient = useQueryClient()

  // Default the version selector to the latest published version once
  // the update report has loaded; the user can pick any older version
  // that is also available on Bambu's download page.
  const installableVersions = useMemo(() => getInstallableVersions(update), [update])
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null)
  useEffect(() => {
    if (selectedVersion) return
    const fallback = getDefaultSelectedVersion(update, installableVersions)
    if (fallback) setSelectedVersion(fallback)
  }, [update, installableVersions, selectedVersion])

  const startUpload = useMutation({
    mutationFn: (version: string) =>
      apiFetch<{ started: boolean }>(`/api/plugins/firmware-updates/updates/${printerId}/upload`, {
        method: 'POST',
        body: { version }
      }),
    onMutate: (version) => {
      queryClient.setQueryData<UploadProgress>(
        [...UPLOAD_QUERY_KEY_PREFIX, printerId],
        {
          printerId,
          status: 'preparing',
          progress: 0,
          message: `Preparing firmware ${version}…`,
          error: null,
          firmwareFilename: null,
          firmwareVersion: version
        }
      )
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: scopeKey ? updatesQueryKey(scopeKey) : UPDATES_QUERY_KEY_PREFIX })
    }
  })
  const cancelUpload = useMutation({
    mutationFn: () =>
      apiFetch<{ cancelled: boolean }>(`/api/plugins/firmware-updates/updates/${printerId}/upload/cancel`, {
        method: 'POST'
      }),
    onMutate: () => {
      queryClient.setQueryData<UploadProgress | undefined>(
        [...UPLOAD_QUERY_KEY_PREFIX, printerId],
        (current) => {
          if (!current) return current
          return {
            ...current,
            message: 'Cancelling firmware upload…'
          }
        }
      )
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...UPLOAD_QUERY_KEY_PREFIX, printerId] })
      void queryClient.invalidateQueries({ queryKey: scopeKey ? updatesQueryKey(scopeKey) : UPDATES_QUERY_KEY_PREFIX })
    }
  })

  const sdMissing = update?.sdCardPresent === false
  const installable = isInstallableVersionSelected(installableVersions, selectedVersion)
  const busy = isActiveUploadStatus(progress?.status)
  const isDowngrade = isDowngradeSelection(update, selectedVersion)
  const pendingInstall = firmwareStillPendingInstall(update, progress)
  const uploadedVersionIsLatest = isUploadedVersionLatest(update, progress)
  const selectedReleaseNotes = useMemo(() => getSelectedReleaseNotes(update, selectedVersion), [selectedVersion, update])

  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 520, width: '100%' }}>
        <DialogTitle>Firmware update — {printerName}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5}>
            {!update && updatesQuery.isLoading && (
              <Typography level="body-sm" textColor="text.tertiary">Loading…</Typography>
            )}

            {update && (
              <>
                <Stack direction="row" spacing={2}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography level="body-xs" textColor="text.tertiary">Installed</Typography>
                    <Typography level="body-md">{update.currentVersion ?? '—'}</Typography>
                  </Box>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography level="body-xs" textColor="text.tertiary">Latest</Typography>
                    <Typography level="body-md">{update.latestVersion ?? '—'}</Typography>
                  </Box>
                </Stack>

                {installableVersions.length > 0 && (
                  <FormControl size="sm">
                    <FormLabel>Version to install</FormLabel>
                    <Select
                      value={selectedVersion ?? ''}
                      onChange={(_event, value) => {
                        if (typeof value === 'string') setSelectedVersion(value)
                      }}
                    >
                      {installableVersions.map((v) => {
                        const isLatest = v.version === update.latestVersion
                        const isCurrent = v.version === update.currentVersion
                        const tags = [
                          isLatest ? 'latest' : null,
                          isCurrent ? 'installed' : null
                        ].filter(Boolean)
                        return (
                          <Option key={v.version} value={v.version}>
                            {v.version}{tags.length > 0 ? ` (${tags.join(', ')})` : ''}
                          </Option>
                        )
                      })}
                    </Select>
                    {isDowngrade && (
                      <Typography level="body-xs" color="warning" sx={{ mt: 0.5 }}>
                        Installing an older firmware than the latest published version.
                      </Typography>
                    )}
                  </FormControl>
                )}

                {selectedReleaseNotes && (
                  <Box>
                    <Typography level="body-xs" textColor="text.tertiary" sx={{ mb: 0.5 }}>
                      Release notes ({selectedVersion})
                    </Typography>
                    <FirmwareReleaseNotes markdown={selectedReleaseNotes} />
                  </Box>
                )}

                <Typography level="body-xs" textColor="text.tertiary">
                  PrintStream uploads firmware to the printer's SD card. After the upload completes, open
                  Settings &gt; Firmware on the printer screen to flash it.
                </Typography>

                {!canManagePrinters && (
                  <Alert color="neutral" variant="soft" startDecorator={<InfoOutlinedIcon />}>
                    Printer management permission is required to upload or cancel firmware uploads.
                  </Alert>
                )}

                {update && !update.online && (
                  <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                    This printer is offline. Connect it before uploading firmware.
                  </Alert>
                )}
                {sdMissing && (
                  <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                    No SD card detected. Insert one before uploading firmware.
                  </Alert>
                )}

                {pendingInstall && (
                  <Alert color={uploadedVersionIsLatest ? 'success' : 'warning'} variant="soft" startDecorator={uploadedVersionIsLatest ? <CheckCircleOutlineRoundedIcon /> : <WarningAmberRoundedIcon />}>
                    Firmware {progress?.firmwareVersion} is already on the SD card but is not installed yet.
                    Open Settings &gt; Firmware on the printer screen to flash it.
                    {!uploadedVersionIsLatest && update?.latestVersion && (
                      <> After that, {update.latestVersion} will still be available to upload.</>
                    )}
                  </Alert>
                )}

                {progress && progress.status !== 'idle' && !(pendingInstall && progress.status === 'complete') && (
                  <Stack spacing={0.5}>
                    <Typography level="body-xs" textColor="text.secondary">
                      {progress.message || progress.status}
                    </Typography>
                    {(progress.status === 'downloading' || progress.status === 'uploading') && (
                      <LinearProgress determinate value={progress.progress} />
                    )}
                    {progress.status === 'cancelled' && (
                      <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>{progress.message}</Alert>
                    )}
                    {progress.status === 'error' && progress.error && (
                      <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>{progress.error}</Alert>
                    )}
                    {progress.status === 'complete' && (
                      <Alert color="success" variant="soft" startDecorator={<CheckCircleOutlineRoundedIcon />}>{progress.message}</Alert>
                    )}
                  </Stack>
                )}
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button variant="plain" color="neutral" onClick={onClose}>
            Close
          </Button>
          {canManagePrinters && busy ? (
            <Button
              variant="plain"
              color="danger"
              loading={cancelUpload.isPending}
              onClick={() => cancelUpload.mutate()}
            >
              Cancel upload
            </Button>
          ) : canManagePrinters ? (
            <Button
              color={isDowngrade ? 'warning' : 'primary'}
              disabled={!update || !update.online || !installable || sdMissing || cancelUpload.isPending || !selectedVersion}
              loading={startUpload.isPending}
              onClick={() => {
                if (selectedVersion) startUpload.mutate(selectedVersion)
              }}
            >
              {selectedVersion ? `Upload ${selectedVersion}` : 'Upload'}
            </Button>
          ) : null}
        </DialogActions>
      </ModalDialog>
    </Modal>
  )
}

function FirmwareUpdateChip({ printerId, printerName }: { printerId: string; printerName: string }) {
  const { canViewPrinters, loading, scopeKey } = useFirmwarePermissions()
  useFirmwareProgressSync()
  useFirmwareUpdatesInvalidation(printerId)
  const updatesQuery = useUpdatesQuery(scopeKey)
  const progress = useUploadProgress(printerId)
  const [open, setOpen] = useState(false)
  const update = updatesQuery.data?.updates.find((u) => u.printerId === printerId)
  const showChip = shouldShowFirmwareUpdateChip(update, progress)
  if (loading || !canViewPrinters) return null
  if (!showChip) return null
  return (
    <>
      <Chip
        size="sm"
        variant="soft"
        color={firmwareChipColor(update, progress)}
        onClick={() => setOpen(true)}
        sx={{ flexShrink: 0, cursor: 'pointer' }}
      >
        {formatFirmwareChipLabel(update, progress)}
      </Chip>
      {open && (
        <FirmwareUpdateDetailsDialog
          printerId={printerId}
          printerName={printerName}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function FirmwareUpdateMenuItem({ printerId }: { printerId: string }) {
  const { canViewPrinters, loading } = useFirmwarePermissions()

  if (loading || !canViewPrinters) return null

  return (
    <MenuItem onClick={() => requestFirmwareDialogOpen(printerId)}>
      Firmware updates…
    </MenuItem>
  )
}

function FirmwareUpdateDialogLauncher({ printerId, printerName }: { printerId: string; printerName: string }) {
  const { canViewPrinters, loading } = useFirmwarePermissions()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    return subscribeToFirmwareDialogOpen(printerId, () => setOpen(true))
  }, [printerId])

  if (loading || !canViewPrinters || !open) return null

  return (
    <FirmwareUpdateDetailsDialog
      printerId={printerId}
      printerName={printerName}
      onClose={() => setOpen(false)}
    />
  )
}

export const firmwareUpdatesPlugin: WebPlugin = {
  name: 'firmware-updates',
  version: '0.1.0',
  description: 'Notify when Bambu Lab firmware updates are available and upload them to the printer\'s SD card.',
  slots: [
    {
      name: 'printer.card.headerChips',
      component: ({ printerId, printerName }) => {
        if (typeof printerId !== 'string' || typeof printerName !== 'string') return null
        return <FirmwareUpdateChip printerId={printerId} printerName={printerName} />
      }
    },
    {
      name: 'printer.card.menuItems',
      component: ({ printerId, printerName }) => {
        if (typeof printerId !== 'string' || typeof printerName !== 'string') return null
        return <FirmwareUpdateMenuItem printerId={printerId} />
      }
    },
    {
      name: 'printer.card.dialogs',
      component: ({ printerId, printerName }) => {
        if (typeof printerId !== 'string' || typeof printerName !== 'string') return null
        return <FirmwareUpdateDialogLauncher printerId={printerId} printerName={printerName} />
      }
    }
  ]
}
