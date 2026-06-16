/**
 * Module-level library upload store with per-file progress, cancel, and retry.
 *
 * Lives outside the React tree so a file/folder upload keeps running — and keeps
 * reporting progress — when the user navigates away from the library (only a full
 * page reload aborts it). Files upload sequentially through the rate-limit-paced
 * chunked uploader; each file's destination is pinned at enqueue time, so
 * navigation never redirects an in-flight batch. Cache refresh rides the server's
 * `resource.changed` WS broadcast.
 *
 * The store is subscribable (see {@link subscribeLibraryUploads}) so a floating
 * upload panel can render each file's status and offer cancel/retry. Identical
 * re-uploads are reported as `unchanged` (the server skips creating a new
 * version) with a toast.
 */
import { isUploadAbortError, uploadLibraryFileInChunks, type ChunkedLibraryUploadPhase, type ChunkedLibraryUploadProgress } from './chunkedLibraryUpload'
import { formatUploadTreeItemPath, type LibraryUploadTreeItem } from './libraryUploadTree'
import { toast } from './toast'

/** Upload target captured when a batch is enqueued, so navigating mid-upload cannot redirect it. */
export interface LibraryUploadDestination {
  folderId: string | null
  bridgeId: string | null
}

export type LibraryUploadStatus = 'queued' | 'uploading' | 'done' | 'unchanged' | 'failed' | 'cancelled'

/** Public, render-friendly view of one upload. */
export interface LibraryUploadEntry {
  id: string
  name: string
  status: LibraryUploadStatus
  uploadedBytes: number
  totalBytes: number
  phase: ChunkedLibraryUploadPhase | null
  error: string | null
}

interface InternalEntry extends LibraryUploadEntry {
  item: LibraryUploadTreeItem
  destination: LibraryUploadDestination
  validateItem: ((item: LibraryUploadTreeItem) => string | null) | null
  abort: AbortController | null
}

const entries = new Map<string, InternalEntry>()
const pending: string[] = []
let draining = false
let idCounter = 0

const listeners = new Set<() => void>()
let snapshot: LibraryUploadEntry[] = []

function toPublic(entry: InternalEntry): LibraryUploadEntry {
  return {
    id: entry.id,
    name: entry.name,
    status: entry.status,
    uploadedBytes: entry.uploadedBytes,
    totalBytes: entry.totalBytes,
    phase: entry.phase,
    error: entry.error
  }
}

function emitChange(): void {
  snapshot = Array.from(entries.values(), toPublic)
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // A faulty subscriber must never break the queue.
    }
  }
}

export function subscribeLibraryUploads(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getLibraryUploadsSnapshot(): LibraryUploadEntry[] {
  return snapshot
}

export function enqueueLibraryUploads(
  items: LibraryUploadTreeItem[],
  destination: LibraryUploadDestination,
  options?: { validateItem?: (item: LibraryUploadTreeItem) => string | null }
): void {
  if (items.length === 0) return
  for (const item of items) {
    const id = `upload-${Date.now().toString(36)}-${idCounter++}`
    entries.set(id, {
      id,
      name: formatUploadTreeItemPath(item),
      status: 'queued',
      uploadedBytes: 0,
      totalBytes: item.file.size,
      phase: null,
      error: null,
      item,
      destination,
      validateItem: options?.validateItem ?? null,
      abort: null
    })
    pending.push(id)
  }
  emitChange()
  if (!draining) void drain()
}

async function drain(): Promise<void> {
  draining = true
  try {
    for (let id = pending.shift(); id; id = pending.shift()) {
      const entry = entries.get(id)
      if (!entry || entry.status !== 'queued') continue
      await runUpload(entry)
    }
  } finally {
    draining = false
  }
}

async function runUpload(entry: InternalEntry): Promise<void> {
  const localError = entry.validateItem?.(entry.item) ?? null
  if (localError) {
    entry.status = 'failed'
    entry.error = localError
    emitChange()
    return
  }

  entry.status = 'uploading'
  entry.phase = 'uploading-to-server'
  entry.uploadedBytes = 0
  entry.abort = new AbortController()
  emitChange()

  try {
    const { unchanged } = await uploadLibraryFileInChunks(entry.item.file, {
      folderId: entry.destination.folderId,
      bridgeId: entry.destination.bridgeId,
      relativeFolderPath: entry.item.folderSegments,
      signal: entry.abort.signal,
      onProgress: (progress) => updateProgress(entry, progress)
    })
    entry.status = unchanged ? 'unchanged' : 'done'
    entry.uploadedBytes = entry.totalBytes
    entry.phase = null
    entry.abort = null
    if (unchanged) {
      toast.show({ message: `${entry.name} is unchanged — no new version created.`, tone: 'neutral', durationMs: 5000 })
    }
    emitChange()
  } catch (error) {
    entry.abort = null
    entry.phase = null
    // Cancellation always aborts the in-flight request, so an AbortError marks a
    // user cancel; anything else is a genuine failure the user can retry.
    if (isUploadAbortError(error)) {
      entry.status = 'cancelled'
    } else {
      entry.status = 'failed'
      entry.error = error instanceof Error ? error.message : 'upload failed'
    }
    emitChange()
  }
}

function updateProgress(entry: InternalEntry, progress: ChunkedLibraryUploadProgress): void {
  if (entry.status !== 'uploading') return
  entry.uploadedBytes = progress.uploadedBytes
  entry.totalBytes = progress.totalBytes
  entry.phase = progress.phase
  emitChange()
}

/** Cancel a queued or in-flight upload. */
export function cancelLibraryUpload(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  if (entry.status === 'uploading') {
    entry.status = 'cancelled'
    entry.abort?.abort()
    emitChange()
    return
  }
  if (entry.status === 'queued') {
    entry.status = 'cancelled'
    const index = pending.indexOf(id)
    if (index >= 0) pending.splice(index, 1)
    emitChange()
  }
}

/** Re-queue a failed or cancelled upload. */
export function retryLibraryUpload(id: string): void {
  const entry = entries.get(id)
  if (!entry || (entry.status !== 'failed' && entry.status !== 'cancelled')) return
  entry.status = 'queued'
  entry.error = null
  entry.uploadedBytes = 0
  entry.phase = null
  pending.push(id)
  emitChange()
  if (!draining) void drain()
}

export function cancelAllLibraryUploads(): void {
  for (const entry of entries.values()) {
    if (entry.status === 'queued' || entry.status === 'uploading') cancelLibraryUpload(entry.id)
  }
}

export function retryFailedLibraryUploads(): void {
  for (const entry of [...entries.values()]) {
    if (entry.status === 'failed' || entry.status === 'cancelled') retryLibraryUpload(entry.id)
  }
}

/** Remove a single finished (done/unchanged/failed/cancelled) entry from the list. */
export function dismissLibraryUpload(id: string): void {
  const entry = entries.get(id)
  if (!entry || entry.status === 'queued' || entry.status === 'uploading') return
  entries.delete(id)
  emitChange()
}

/** Remove all finished entries, leaving active ones in place. */
export function clearFinishedLibraryUploads(): void {
  for (const entry of [...entries.values()]) {
    if (entry.status !== 'queued' && entry.status !== 'uploading') entries.delete(entry.id)
  }
  emitChange()
}
