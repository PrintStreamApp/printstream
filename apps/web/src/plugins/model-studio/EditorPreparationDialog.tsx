/**
 * Blocking feedback while the editor turns its live scene into saveable or sliceable 3MF bytes.
 *
 * Thumbnail capture and the client-side bake can take several seconds before the destination
 * surface has anything to show. The editor must stay untouched during that work because the
 * operation authors a snapshot of the state captured when the user clicked the action.
 */
import { Button, DialogActions, ModalClose, ModalDialog, Stack, Typography } from '@mui/joy'
import React from 'react'
import { BackAwareModal } from '../../components/BackAwareModal'
import { ProgressBar } from '../../components/ProgressBar'
import { formatBytes } from '@printstream/shared'
import type { ChunkedLibraryUploadProgress } from '../../lib/chunkedLibraryUpload'

export type EditorPreparationAction = 'save' | 'slice'
export type SavePreparationPhase = 'checking' | 'creating'
export type SlicePreparationPhase = 'collecting' | 'applying' | 'uploading' | 'finalizing' | 'reconciling' | 'recovery-required'

const SLICE_TITLES: Record<SlicePreparationPhase, string> = {
  collecting: 'Collecting project changes',
  applying: 'Creating project for slicing',
  uploading: 'Uploading project for slicing',
  finalizing: 'Checking project for slicing',
  reconciling: 'Checking upload status',
  'recovery-required': 'Project upload not confirmed'
}

export function EditorPreparationDialog({
  action,
  savePhase = 'checking',
  slicePhase = 'collecting',
  finalizing = false,
  transferProgress,
  recoveryMessage,
  error,
  onCancel,
  onRetry,
  onRetryStatus,
  onStopWaiting
}: {
  action: EditorPreparationAction | null
  savePhase?: SavePreparationPhase
  slicePhase?: SlicePreparationPhase
  finalizing?: boolean
  transferProgress?: ChunkedLibraryUploadProgress | null
  recoveryMessage?: string | null
  error?: string | null
  onCancel: () => void
  onRetry?: () => void
  onRetryStatus?: () => void
  onStopWaiting?: () => void
}) {
  if (!action) return null
  if (error) {
    const title = action === 'slice' ? 'Could not start slicing' : 'Could not save project'
    return (
      <BackAwareModal open onClose={() => { onCancel() }}>
        <ModalDialog
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={`editor-${action}-preparation-error-title`}
          sx={{ width: { xs: 'calc(100% - 24px)', sm: 420 } }}
        >
          <ModalClose />
          <Stack spacing={1.5}>
            <Typography id={`editor-${action}-preparation-error-title`} level="title-md">{title}</Typography>
            <Typography level="body-sm" color="danger">{error}</Typography>
          </Stack>
          <DialogActions>
            <Button variant="plain" color="neutral" onClick={onCancel}>Close</Button>
            {onRetry && <Button variant="solid" onClick={onRetry}>Try again</Button>}
          </DialogActions>
        </ModalDialog>
      </BackAwareModal>
    )
  }
  const reconciling = slicePhase === 'reconciling'
  const recoveryRequired = slicePhase === 'recovery-required'
  // Staging a slice can always be abandoned: the server may finish storing an immutable hidden
  // snapshot, but without the later job request nothing can print and cleanup reclaims it. A save
  // is different once commit begins because the visible file version may already have changed.
  const committing = finalizing || slicePhase === 'finalizing'
  const cancellationLocked = action === 'save' && (committing || reconciling || recoveryRequired)
  const browserUploadComplete = transferProgress?.phase === 'uploading-to-server' &&
    transferProgress.totalBytes > 0 && transferProgress.uploadedBytes >= transferProgress.totalBytes
  const waitingAfterUpload = browserUploadComplete && (committing || reconciling || recoveryRequired)
  const effectiveTransferPhase = waitingAfterUpload ? 'waiting-for-server' : transferProgress?.phase
  const waitingForTransfer = effectiveTransferPhase === 'waiting-for-server'
  const waitingWithCompleteUpload = waitingForTransfer && Boolean(transferProgress &&
    transferProgress.totalBytes > 0 && transferProgress.uploadedBytes >= transferProgress.totalBytes)
  const transferTitle = effectiveTransferPhase === 'uploading-to-server'
    ? action === 'save' ? 'Uploading project' : 'Uploading project for slicing'
    : effectiveTransferPhase === 'sending-to-bridge'
      ? action === 'save' ? 'Saving project to your library' : 'Making project available to the slicer'
      : effectiveTransferPhase === 'waiting-for-server'
        ? waitingWithCompleteUpload
          ? action === 'save' ? 'Saving project to your library' : 'Upload complete'
          : action === 'save' ? 'Uploading project' : 'Uploading project for slicing'
        : effectiveTransferPhase === 'finalizing'
          ? action === 'save' ? 'Adding project to your library' : 'Checking project for slicing'
          : null
  const title = recoveryRequired
    ? action === 'save' ? 'Project save not confirmed' : SLICE_TITLES['recovery-required']
    : reconciling
      ? action === 'save' ? 'Checking whether the save finished' : 'Checking whether the project is ready'
      : transferTitle ?? (action === 'save'
        ? cancellationLocked
          ? 'Adding project to your library'
          : savePhase === 'checking' ? 'Checking for newer saves' : 'Creating project file'
        : SLICE_TITLES[slicePhase])
  const transferPercent = !reconciling && !waitingWithCompleteUpload && transferProgress && transferProgress.totalBytes > 0 && (
    transferProgress.phase === 'uploading-to-server' ||
    transferProgress.phase === 'waiting-for-server' ||
    (transferProgress.phase === 'sending-to-bridge' && transferProgress.uploadedBytes > 0)
  )
    ? Math.min(100, Math.round((transferProgress.uploadedBytes / transferProgress.totalBytes) * 100))
    : null
  const transferDescription = reconciling || recoveryRequired
    ? null
    : waitingWithCompleteUpload
      ? action === 'save'
        ? 'Upload complete. Waiting for your library to start saving it.'
        : 'Waiting to check the project before slicing.'
      : transferProgress?.phase === 'uploading-to-server'
    ? `${formatBytes(transferProgress.uploadedBytes)} of ${formatBytes(transferProgress.totalBytes)} uploaded.`
    : transferProgress?.phase === 'sending-to-bridge'
      ? `${formatBytes(transferProgress.uploadedBytes)} of ${formatBytes(transferProgress.totalBytes)} transferred ${action === 'save' ? 'to your library' : 'for slicing'}.`
        : transferProgress?.phase === 'waiting-for-server'
          ? transferProgress.uploadedBytes > 0
            ? `${formatBytes(transferProgress.uploadedBytes)} of ${formatBytes(transferProgress.totalBytes)} uploaded. Waiting to continue; the upload will resume automatically.`
            : 'Waiting to start the upload. It will begin automatically.'
        : transferProgress?.phase === 'finalizing'
          ? action === 'save'
            ? 'Creating a new saved version.'
            : 'Making sure the uploaded project is complete and ready to slice.'
          : null
  const localDescription = transferDescription || transferProgress
    ? null
    : action === 'save'
      ? savePhase === 'checking'
        ? 'Checking whether this project was saved elsewhere since you opened it.'
        : 'Writing your edits and settings into a new 3MF file.'
      : slicePhase === 'collecting'
        ? 'Gathering the current objects, layout, and settings for this slice.'
        : slicePhase === 'applying'
          ? 'Creating file to send to slicer.'
          : null

  return (
    <BackAwareModal
      open
      onClose={action === 'save' && (reconciling || recoveryRequired)
        ? () => { onStopWaiting?.() }
        : cancellationLocked
          ? () => undefined
          : () => { onCancel() }}
    >
      <ModalDialog
        role="dialog"
        aria-modal="true"
        aria-labelledby={`editor-${action}-preparation-title`}
        sx={{ width: { xs: 'calc(100% - 24px)', sm: 420 } }}
      >
        {!cancellationLocked && <ModalClose />}
        <Stack spacing={1.5} aria-live="polite">
          <Typography id={`editor-${action}-preparation-title`} level="title-md">{title}</Typography>
          {!recoveryRequired && <ProgressBar value={transferPercent} />}
          {transferDescription && (
            <Typography level="body-sm" textColor="text.tertiary">{transferDescription}</Typography>
          )}
          {localDescription && (
            <Typography level="body-sm" textColor="text.tertiary">{localDescription}</Typography>
          )}
          {cancellationLocked && !reconciling && !recoveryRequired && !transferDescription && (
            <Typography level="body-sm" textColor="text.tertiary">
              This last step cannot be cancelled.
            </Typography>
          )}
          {reconciling && !transferDescription && (
            <Typography level="body-sm" textColor="text.tertiary">
              {action === 'save'
                ? 'The save request did not return a result. Checking that same save now; the project is not being uploaded again.'
                : 'The preparation request did not return a result. Checking that same request now; the project is not being uploaded again.'}
            </Typography>
          )}
          {recoveryRequired && (
            <Stack spacing={0.75}>
              <Typography level="body-sm" textColor="text.tertiary">
                {action === 'save'
                  ? 'The save still has no confirmed result. Retry, or stop checking and inspect the Library before saving again.'
                  : 'The project still has no confirmed result. Retry, or stop checking and return to the editor.'}
              </Typography>
              {recoveryMessage && (
                <Typography level="body-xs" textColor="text.tertiary">{recoveryMessage}</Typography>
              )}
            </Stack>
          )}
        </Stack>
        {(reconciling || recoveryRequired) && (onRetryStatus || onStopWaiting || action === 'slice') && (
          <DialogActions>
            {action === 'save' && onStopWaiting && (
              <Button variant="plain" color="neutral" onClick={onStopWaiting}>Stop checking</Button>
            )}
            {action === 'slice' && (
              <Button variant="plain" color="neutral" onClick={onCancel}>Cancel</Button>
            )}
            {recoveryRequired && onRetryStatus && <Button variant="solid" onClick={onRetryStatus}>Retry status check</Button>}
          </DialogActions>
        )}
        {!cancellationLocked && !reconciling && !recoveryRequired && (
          <DialogActions>
            <Button variant="plain" color="neutral" onClick={onCancel}>Cancel</Button>
          </DialogActions>
        )}
      </ModalDialog>
    </BackAwareModal>
  )
}
