/**
 * Chooses the editor preparation dialog's copy and progress from save/slice state.
 * A completed browser upload becomes a server wait during commit or reconciliation;
 * leaving its progress at 100% would suggest the visible file was already saved.
 */
import { formatBytes } from '@printstream/shared'
import type { ChunkedLibraryUploadProgress } from '../../../lib/chunkedLibraryUpload'
import type {
  EditorPreparationAction,
  SavePreparationPhase,
  SlicePreparationPhase
} from '../EditorPreparationDialog'

const SLICE_TITLES: Record<SlicePreparationPhase, string> = {
  collecting: 'Collecting project changes',
  applying: 'Creating project for slicing',
  uploading: 'Uploading project for slicing',
  finalizing: 'Checking project for slicing',
  reconciling: 'Checking upload status',
  'recovery-required': 'Project upload not confirmed'
}

interface PreparationPresentationOptions {
  action: EditorPreparationAction
  savePhase: SavePreparationPhase
  slicePhase: SlicePreparationPhase
  finalizing: boolean
  transferProgress?: ChunkedLibraryUploadProgress | null
}

interface PreparationDialogStateOptions {
  slicePreparationError: string | null
  preparingSlice: boolean
  slicing: boolean
  savePreparationError: string | null
  preparingSave: boolean
  recoveryMessage: string | null
  savePreparationReconciling: boolean
  slicePreparationPhase: SlicePreparationPhase
}

/** Choose which preparation operation owns the blocking dialog and its phase. */
export function editorPreparationDialogState(options: PreparationDialogStateOptions): {
  action: EditorPreparationAction | null
  slicePhase: SlicePreparationPhase
} {
  let action: EditorPreparationAction | null = null
  if (options.slicePreparationError || (options.preparingSlice && !options.slicing)) {
    action = 'slice'
  } else if (options.savePreparationError || options.preparingSave) {
    action = 'save'
  }

  let slicePhase = options.slicePreparationPhase
  if (options.recoveryMessage) {
    slicePhase = 'recovery-required'
  } else if (options.preparingSave && options.savePreparationReconciling) {
    slicePhase = 'reconciling'
  }
  return { action, slicePhase }
}

/** Return visible status and cancellation policy for one preparation state. */
export function editorPreparationPresentation(options: PreparationPresentationOptions) {
  const { action, savePhase, slicePhase, finalizing, transferProgress } = options
  const reconciling = slicePhase === 'reconciling'
  const recoveryRequired = slicePhase === 'recovery-required'
  const committing = finalizing || slicePhase === 'finalizing'
  // A hidden slice snapshot can be abandoned; a visible save may already have committed.
  const cancellationLocked = action === 'save' && (committing || reconciling || recoveryRequired)
  const browserUploadComplete = transferProgress?.phase === 'uploading-to-server' &&
    transferProgress.totalBytes > 0 && transferProgress.uploadedBytes >= transferProgress.totalBytes
  const waitingAfterUpload = browserUploadComplete && (committing || reconciling || recoveryRequired)
  const effectiveTransferPhase = waitingAfterUpload ? 'waiting-for-server' : transferProgress?.phase
  const waitingWithCompleteUpload = effectiveTransferPhase === 'waiting-for-server' && Boolean(
    transferProgress && transferProgress.totalBytes > 0 &&
    transferProgress.uploadedBytes >= transferProgress.totalBytes
  )

  let transferTitle: string | null = null
  switch (effectiveTransferPhase) {
    case 'uploading-to-server':
      transferTitle = action === 'save' ? 'Uploading project' : 'Uploading project for slicing'
      break
    case 'sending-to-bridge':
      transferTitle = action === 'save' ? 'Saving project to your library' : 'Making project available to the slicer'
      break
    case 'waiting-for-server':
      if (waitingWithCompleteUpload) {
        transferTitle = action === 'save' ? 'Saving project to your library' : 'Upload complete'
      } else {
        transferTitle = action === 'save' ? 'Uploading project' : 'Uploading project for slicing'
      }
      break
    case 'finalizing':
      transferTitle = action === 'save' ? 'Adding project to your library' : 'Checking project for slicing'
      break
  }

  let title: string
  if (recoveryRequired) {
    title = action === 'save' ? 'Project save not confirmed' : SLICE_TITLES['recovery-required']
  } else if (reconciling) {
    title = action === 'save' ? 'Checking whether the save finished' : 'Checking whether the project is ready'
  } else if (transferTitle) {
    title = transferTitle
  } else if (action === 'slice') {
    title = SLICE_TITLES[slicePhase]
  } else if (cancellationLocked) {
    title = 'Adding project to your library'
  } else {
    title = savePhase === 'checking' ? 'Checking for newer saves' : 'Creating project file'
  }

  let transferPercent: number | null = null
  if (!reconciling && !waitingWithCompleteUpload && transferProgress && transferProgress.totalBytes > 0) {
    const phase = transferProgress.phase
    if (phase === 'uploading-to-server' || phase === 'waiting-for-server' ||
      (phase === 'sending-to-bridge' && transferProgress.uploadedBytes > 0)) {
      transferPercent = Math.min(100, Math.round(
        (transferProgress.uploadedBytes / transferProgress.totalBytes) * 100
      ))
    }
  }

  let transferDescription: string | null = null
  if (!reconciling && !recoveryRequired) {
    if (waitingWithCompleteUpload) {
      transferDescription = action === 'save'
        ? 'Upload complete. Waiting for your library to start saving it.'
        : 'Waiting to check the project before slicing.'
    } else if (transferProgress?.phase === 'uploading-to-server') {
      transferDescription = `${formatBytes(transferProgress.uploadedBytes)} of ${formatBytes(transferProgress.totalBytes)} uploaded.`
    } else if (transferProgress?.phase === 'sending-to-bridge') {
      const destination = action === 'save' ? 'to your library' : 'for slicing'
      transferDescription = `${formatBytes(transferProgress.uploadedBytes)} of ${formatBytes(transferProgress.totalBytes)} transferred ${destination}.`
    } else if (transferProgress?.phase === 'waiting-for-server') {
      transferDescription = transferProgress.uploadedBytes > 0
        ? `${formatBytes(transferProgress.uploadedBytes)} of ${formatBytes(transferProgress.totalBytes)} uploaded. Waiting to continue; the upload will resume automatically.`
        : 'Waiting to start the upload. It will begin automatically.'
    } else if (transferProgress?.phase === 'finalizing') {
      transferDescription = action === 'save'
        ? 'Creating a new saved version.'
        : 'Making sure the uploaded project is complete and ready to slice.'
    }
  }

  let localDescription: string | null = null
  if (!transferDescription && !transferProgress) {
    if (action === 'save') {
      localDescription = savePhase === 'checking'
        ? 'Checking whether this project was saved elsewhere since you opened it.'
        : 'Writing your edits and settings into a new 3MF file.'
    } else if (slicePhase === 'collecting') {
      localDescription = 'Gathering the current objects, layout, and settings for this slice.'
    } else if (slicePhase === 'applying') {
      localDescription = 'Creating file to send to slicer.'
    }
  }

  return {
    reconciling,
    recoveryRequired,
    cancellationLocked,
    title,
    transferPercent,
    transferDescription,
    localDescription
  }
}
