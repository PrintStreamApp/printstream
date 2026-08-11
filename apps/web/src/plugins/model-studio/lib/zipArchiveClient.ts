/**
 * Main-thread client for `zipArchiveWorker.ts` — whole-archive zip/unzip that ALWAYS settles.
 *
 * Owns the contract the archive read/write paths rely on: every call ends in resolved bytes or a
 * thrown error, bounded in time. The previous approach (fflate's async API on the main thread)
 * could wedge without erroring under CPU starvation, which left the editor on "Loading plates…"
 * forever with no error state and a pile of leaked per-entry workers. Here each operation gets one
 * dedicated worker, a size-scaled deadline, and `terminate()` in a `finally` — a wedged worker is
 * killed, not leaked.
 *
 * Failure semantics, two distinct classes:
 *  - DATA errors (corrupt zip, bad entry) reject with the codec's message and are NOT retried on
 *    the main thread — the same bytes would just fail again.
 *  - MECHANISM failures (no `Worker` global, the worker module failing to load, the deadline
 *    expiring) fall back to fflate's synchronous codec on the main thread: a brief freeze beats an
 *    open or save that never settles. Node tests take this path by design (no `Worker` there), so
 *    the fallback only warns when a worker was actually attempted.
 */
import { unzipSync, zipSync } from 'fflate'
import type { ZipArchiveRequest, ZipArchiveResponse, ZipCompressionLevel } from './zipArchiveWorker'

/** Floor of the per-operation deadline, so tiny archives still absorb worker spawn + queue time. */
export const ZIP_ARCHIVE_BASE_DEADLINE_MS = 30_000

/**
 * Deadline for one worker operation, scaled by payload size: the base plus ~1ms per KB (≈1MB/s of
 * assumed codec throughput — generous even for a weak machine, while still bounding a wedged
 * worker to minutes rather than forever).
 */
export function zipArchiveDeadlineMs(byteLength: number): number {
  return ZIP_ARCHIVE_BASE_DEADLINE_MS + Math.ceil(byteLength / 1024)
}

/** A data-level codec failure reported by the worker; never retried on the main thread. */
class ZipArchiveDataError extends Error {}

/** Thrown when this environment has no `Worker` at all (node tests, exotic embedders). */
class WorkerUnavailableError extends Error {
  constructor() {
    super('Worker is unavailable in this environment')
  }
}

/**
 * Run one request on a fresh dedicated worker. The worker is terminated in `finally` — including
 * on deadline expiry — so no code path can leak it. Inputs are posted WITHOUT a transfer list
 * (structured clone): zip entries can be views into a live open archive, and detaching those
 * buffers would corrupt the project they came from.
 */
async function runViaWorker(request: ZipArchiveRequest, deadlineMs: number): Promise<ZipArchiveResponse & { ok: true }> {
  if (typeof Worker === 'undefined') throw new WorkerUnavailableError()
  const worker = new Worker(new URL('./zipArchiveWorker.ts', import.meta.url), { type: 'module' })
  try {
    const response = await new Promise<ZipArchiveResponse>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`zip archive worker made no progress within ${deadlineMs}ms`)),
        deadlineMs
      )
      worker.onmessage = (event: MessageEvent<ZipArchiveResponse>) => {
        clearTimeout(timer)
        resolve(event.data)
      }
      worker.onerror = (event) => {
        clearTimeout(timer)
        reject(new Error(event.message || 'zip archive worker failed to load'))
      }
      worker.postMessage(request)
    })
    if (!response.ok) throw new ZipArchiveDataError(response.error)
    return response
  } finally {
    worker.terminate()
  }
}

function shouldFallBack(error: unknown): boolean {
  if (error instanceof ZipArchiveDataError) return false
  // Expected in worker-less environments; warn only when a real worker was attempted and failed,
  // so the operational signal is not buried under one line per node test.
  if (!(error instanceof WorkerUnavailableError)) {
    console.warn('[zipArchive] worker unavailable or stalled; using main-thread fallback', error)
  }
  return true
}

/** Inflate a whole zip archive to its entries, off the main thread when workers are available. */
export async function unzipArchiveBytes(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  try {
    const response = await runViaWorker({ op: 'unzip', bytes }, zipArchiveDeadlineMs(bytes.byteLength))
    if ('entries' in response) return response.entries
    throw new Error('zip archive worker returned the wrong response shape')
  } catch (error) {
    if (!shouldFallBack(error)) throw new Error(error instanceof Error ? error.message : String(error))
    return unzipSync(bytes)
  }
}

/** Deflate entries to a zip archive, off the main thread when workers are available. */
export async function zipArchiveEntries(
  entries: Record<string, Uint8Array>,
  level: ZipCompressionLevel
): Promise<Uint8Array> {
  const totalBytes = Object.values(entries).reduce((sum, entry) => sum + entry.byteLength, 0)
  try {
    const response = await runViaWorker({ op: 'zip', entries, level }, zipArchiveDeadlineMs(totalBytes))
    if ('bytes' in response) return response.bytes
    throw new Error('zip archive worker returned the wrong response shape')
  } catch (error) {
    if (!shouldFallBack(error)) throw new Error(error instanceof Error ? error.message : String(error))
    return zipSync(entries, { level })
  }
}
