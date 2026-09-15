/**
 * Stable opening status for Model Studio's project-loading phases.
 *
 * The linear indicator is always present. It is indeterminate until the project download reports
 * a total byte count, and the detail row keeps its height while hidden so phase changes do not move
 * the status block around the dialog.
 */
import { Stack, Typography } from '@mui/joy'
import { formatBytes } from '@printstream/shared'
import React from 'react'
import { ProgressBar } from '../../components/ProgressBar'
import type { ModelFetchProgress } from './lib/modelFetch'

/** Opening label with a stable progress track and optional byte-level detail. */
export function EditorOpeningStatus({
  label,
  downloadProgress
}: {
  label: string
  downloadProgress?: ModelFetchProgress | null
}) {
  const percent = downloadProgress?.totalBytes
    ? Math.min(100, Math.round((downloadProgress.loadedBytes / downloadProgress.totalBytes) * 100))
    : null
  const detail = downloadProgress
    ? downloadProgress.totalBytes != null
      ? `${formatBytes(downloadProgress.loadedBytes)} of ${formatBytes(downloadProgress.totalBytes)}`
      : `${formatBytes(downloadProgress.loadedBytes)} downloaded`
    : '\u00a0'

  return (
    <Stack spacing={1} alignItems="center" role="status" aria-live="polite">
      <Typography level="body-sm" textColor="text.tertiary">{label}</Typography>
      <Stack spacing={0.5} sx={{ width: { xs: 240, sm: 320 } }}>
        <ProgressBar value={percent} />
        <Typography
          level="body-xs"
          textColor="text.tertiary"
          textAlign="center"
          aria-hidden={!downloadProgress}
          sx={{ visibility: downloadProgress ? 'visible' : 'hidden' }}
        >
          {detail}
        </Typography>
      </Stack>
    </Stack>
  )
}
