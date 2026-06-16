/**
 * Module-level library upload queue with toast-based progress.
 *
 * Lives outside the React tree so a file/folder upload keeps running — and
 * keeps reporting progress — when the user navigates away from the library
 * (only a full page reload aborts it). Items upload sequentially through the
 * rate-limit-paced chunked uploader; each file's destination is pinned at
 * enqueue time, so navigation never redirects an in-flight batch. Cache
 * refresh rides the server's `resource.changed` WS broadcast, so no
 * queryClient handle is needed here.
 */
import { uploadLibraryFileInChunks, type ChunkedLibraryUploadProgress } from './chunkedLibraryUpload'
import { formatUploadTreeItemPath, type LibraryUploadTreeItem } from './libraryUploadTree'
import { toast } from './toast'

/** Upload target captured when a batch is enqueued, so navigating mid-upload cannot redirect it. */
export interface LibraryUploadDestination {
  folderId: string | null
  bridgeId: string | null
}

interface QueuedUpload {
  item: LibraryUploadTreeItem
  destination: LibraryUploadDestination
  /** Returns an error message to fail the file locally (e.g. demo size cap), or null to upload. */
  validateItem: ((item: LibraryUploadTreeItem) => string | null) | null
}

const queue: QueuedUpload[] = []
let draining = false
let progressToastId: number | null = null
// Set when the user dismisses the progress toast mid-run: stop re-showing
// progress for the rest of the run (the final failure summary still appears).
let progressSuppressed = false
// Counters span the whole drain run: enqueueing more while uploads are running
// extends the same progress toast instead of spawning a second one.
let totalCount = 0
let doneCount = 0
let failureCount = 0
let firstError: string | null = null

export function enqueueLibraryUploads(
  items: LibraryUploadTreeItem[],
  destination: LibraryUploadDestination,
  options?: { validateItem?: (item: LibraryUploadTreeItem) => string | null }
): void {
  if (items.length === 0) return
  for (const item of items) {
    queue.push({ item, destination, validateItem: options?.validateItem ?? null })
  }
  totalCount += items.length
  if (!draining) void drain()
}

async function drain(): Promise<void> {
  draining = true
  try {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const path = formatUploadTreeItemPath(next.item)
      const localError = next.validateItem?.(next.item) ?? null
      if (localError) {
        recordFailure(path, localError)
      } else {
        updateProgressToast(path, { phase: 'uploading-to-server', uploadedBytes: 0, totalBytes: next.item.file.size })
        try {
          await uploadLibraryFileInChunks(next.item.file, {
            folderId: next.destination.folderId,
            bridgeId: next.destination.bridgeId,
            relativeFolderPath: next.item.folderSegments,
            onProgress: (progress) => updateProgressToast(path, progress)
          })
        } catch (error) {
          recordFailure(path, error instanceof Error ? error.message : 'upload failed')
        }
      }
      doneCount += 1
    }
  } finally {
    draining = false
    finishProgressToast()
  }
}

function recordFailure(path: string, message: string): void {
  failureCount += 1
  if (!firstError) firstError = `${path}: ${message}`
}

function updateProgressToast(path: string, progress: ChunkedLibraryUploadProgress): void {
  if (progressSuppressed) return
  const counter = totalCount > 1 ? `${doneCount + 1} of ${totalCount} — ` : ''
  const detail = formatProgressDetail(progress)
  const message = `Uploading ${counter}${path}${detail ? ` · ${detail}` : ''}`
  const percent = Math.floor((progress.uploadedBytes / Math.max(progress.totalBytes, 1)) * 100)
  if (progressToastId === null) {
    const id = toast.loading({
      message,
      progress: percent,
      onClose: (reason) => {
        if (progressToastId === id) progressToastId = null
        if (reason === 'dismiss' && draining) progressSuppressed = true
      }
    })
    progressToastId = id
  } else {
    toast.update(progressToastId, { message, progress: percent })
  }
}

function formatProgressDetail(progress: ChunkedLibraryUploadProgress): string {
  switch (progress.phase) {
    case 'sending-to-bridge':
      return 'sending to bridge'
    case 'finalizing':
      return 'finalizing'
    case 'waiting-for-server':
      return 'waiting for server (rate limited)'
    case 'uploading-to-server':
    default:
      return ''
  }
}

function finishProgressToast(): void {
  const summary = failureCount > 0
    ? {
        message: failureCount === 1 && totalCount === 1 && firstError
          ? `Upload failed — ${firstError}`
          : `${failureCount} of ${totalCount} uploads failed. First error — ${firstError ?? 'unknown error'}`,
        tone: 'danger' as const,
        loading: false,
        progress: null,
        // Failures stay until dismissed; the user may have left the library.
        durationMs: 0
      }
    : {
        message: totalCount === 1 ? 'Upload complete' : `Uploaded ${totalCount} files`,
        tone: 'success' as const,
        loading: false,
        progress: null,
        durationMs: 6000
      }
  if (progressToastId !== null) {
    toast.update(progressToastId, summary)
    progressToastId = null
  } else if (failureCount > 0 || !progressSuppressed) {
    // A user who dismissed the progress toast opted out of the happy-path
    // chatter, but failures must still surface.
    toast.show(summary)
  }
  progressSuppressed = false
  totalCount = 0
  doneCount = 0
  failureCount = 0
  firstError = null
}
