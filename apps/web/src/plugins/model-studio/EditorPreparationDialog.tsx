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
import type { ChunkedLibraryUploadProgress } from '../../lib/chunkedLibraryUpload'
import { editorPreparationPresentation } from './lib/editorPreparationPresentation'

export type EditorPreparationAction = 'save' | 'slice'
export type SavePreparationPhase = 'checking' | 'creating'
export type SlicePreparationPhase = 'collecting' | 'applying' | 'uploading' | 'finalizing' | 'reconciling' | 'recovery-required'

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
  const {
    reconciling,
    recoveryRequired,
    cancellationLocked,
    title,
    transferPercent,
    transferDescription,
    localDescription
  } = editorPreparationPresentation({ action, savePhase, slicePhase, finalizing, transferProgress })
  const handleClose = () => {
    if (action === 'save' && (reconciling || recoveryRequired)) {
      onStopWaiting?.()
      return
    }
    if (!cancellationLocked) onCancel()
  }

  return (
    <BackAwareModal
      open
      onClose={handleClose}
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
