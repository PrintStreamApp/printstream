/**
 * Floating, app-wide library upload panel.
 *
 * Subscribes to the module-level upload store and shows each file's progress with
 * per-file Cancel (in-flight) and Retry (failed/cancelled) actions, plus batch
 * "Cancel all" / "Retry failed" / "Clear". Mounted once near the app shell so it
 * persists across navigation, mirroring how uploads keep running outside the
 * React tree.
 */
import { useSyncExternalStore } from 'react'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'
import { Box, IconButton, LinearProgress, Sheet, Stack, Tooltip, Typography } from '@mui/joy'
import {
  cancelAllLibraryUploads,
  cancelLibraryUpload,
  clearFinishedLibraryUploads,
  dismissLibraryUpload,
  getLibraryUploadsSnapshot,
  retryFailedLibraryUploads,
  retryLibraryUpload,
  subscribeLibraryUploads,
  type LibraryUploadEntry
} from '../lib/libraryUploadQueue'

const PHASE_LABELS: Record<string, string> = {
  'uploading-to-server': 'Uploading',
  'sending-to-bridge': 'Sending to bridge',
  finalizing: 'Finalizing',
  'waiting-for-server': 'Waiting (rate limited)'
}

function statusLabel(entry: LibraryUploadEntry): string {
  switch (entry.status) {
    case 'queued':
      return 'Waiting…'
    case 'uploading':
      return entry.phase ? PHASE_LABELS[entry.phase] ?? 'Uploading' : 'Uploading'
    case 'done':
      return 'Uploaded'
    case 'unchanged':
      return 'Unchanged — no new version'
    case 'cancelled':
      return 'Cancelled'
    case 'failed':
      return entry.error ?? 'Upload failed'
  }
}

function statusColor(status: LibraryUploadEntry['status']): 'primary' | 'success' | 'neutral' | 'danger' {
  if (status === 'failed') return 'danger'
  if (status === 'done') return 'success'
  if (status === 'uploading' || status === 'queued') return 'primary'
  return 'neutral'
}

export function LibraryUploadPanel() {
  const uploads = useSyncExternalStore(subscribeLibraryUploads, getLibraryUploadsSnapshot, getLibraryUploadsSnapshot)
  if (uploads.length === 0) return null

  const activeCount = uploads.filter((upload) => upload.status === 'queued' || upload.status === 'uploading').length
  const retryableCount = uploads.filter((upload) => upload.status === 'failed' || upload.status === 'cancelled').length
  const finishedCount = uploads.length - activeCount
  const headerLabel = activeCount > 0
    ? `Uploading ${activeCount} file${activeCount === 1 ? '' : 's'}`
    : `Uploads (${uploads.length})`

  return (
    <Sheet
      variant="outlined"
      sx={{
        position: 'fixed',
        bottom: { xs: 8, sm: 16 },
        right: { xs: 8, sm: 16 },
        left: { xs: 8, sm: 'auto' },
        width: { xs: 'auto', sm: 380 },
        maxWidth: 'calc(100vw - 16px)',
        zIndex: (theme) => theme.zIndex.snackbar,
        borderRadius: 'md',
        boxShadow: 'lg',
        overflow: 'hidden'
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ px: 1.5, py: 1, borderBottom: '1px solid', borderColor: 'divider' }}
      >
        <Typography level="title-sm" sx={{ flex: 1, minWidth: 0 }} noWrap>{headerLabel}</Typography>
        {retryableCount > 0 && (
          <Typography
            level="body-xs"
            color="primary"
            sx={{ cursor: 'pointer' }}
            onClick={() => retryFailedLibraryUploads()}
          >
            Retry failed
          </Typography>
        )}
        {activeCount > 0 && (
          <Typography
            level="body-xs"
            color="danger"
            sx={{ cursor: 'pointer' }}
            onClick={() => cancelAllLibraryUploads()}
          >
            Cancel all
          </Typography>
        )}
        {activeCount === 0 && finishedCount > 0 && (
          <Tooltip title="Clear" size="sm" variant="soft">
            <IconButton size="sm" variant="plain" color="neutral" aria-label="Clear uploads" onClick={() => clearFinishedLibraryUploads()}>
              <CloseRoundedIcon />
            </IconButton>
          </Tooltip>
        )}
      </Stack>

      <Stack sx={{ maxHeight: 280, overflowY: 'auto' }}>
        {uploads.map((upload) => (
          <UploadRow key={upload.id} upload={upload} />
        ))}
      </Stack>
    </Sheet>
  )
}

function UploadRow({ upload }: { upload: LibraryUploadEntry }) {
  const percent = upload.totalBytes > 0 ? Math.min(100, Math.floor((upload.uploadedBytes / upload.totalBytes) * 100)) : 0
  const isActive = upload.status === 'queued' || upload.status === 'uploading'
  const isRetryable = upload.status === 'failed' || upload.status === 'cancelled'

  return (
    <Box sx={{ px: 1.5, py: 1, borderBottom: '1px solid', borderColor: 'divider', '&:last-of-type': { borderBottom: 'none' } }}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="body-sm" noWrap>{upload.name}</Typography>
          <Typography level="body-xs" color={statusColor(upload.status)} noWrap>
            {statusLabel(upload)}
            {upload.status === 'uploading' ? ` · ${percent}%` : ''}
          </Typography>
        </Box>
        {isRetryable && (
          <Tooltip title="Retry" size="sm" variant="soft">
            <IconButton size="sm" variant="plain" color="primary" aria-label={`Retry ${upload.name}`} onClick={() => retryLibraryUpload(upload.id)}>
              <RefreshRoundedIcon />
            </IconButton>
          </Tooltip>
        )}
        {(isActive || isRetryable || upload.status === 'done' || upload.status === 'unchanged') && (
          <Tooltip title={isActive ? 'Cancel' : 'Dismiss'} size="sm" variant="soft">
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              aria-label={isActive ? `Cancel ${upload.name}` : `Dismiss ${upload.name}`}
              onClick={() => (isActive ? cancelLibraryUpload(upload.id) : dismissLibraryUpload(upload.id))}
            >
              <CloseRoundedIcon />
            </IconButton>
          </Tooltip>
        )}
      </Stack>
      {upload.status === 'uploading' && (
        <LinearProgress determinate value={percent} size="sm" sx={{ mt: 0.75 }} />
      )}
    </Box>
  )
}
