/**
 * Web Worker that zips / unzips a whole archive off the main thread.
 *
 * Runs fflate's SYNCHRONOUS codecs inside one dedicated worker, replacing fflate's async API on
 * the main thread. That API spawns a worker per zip entry, so a single project open burst-spawned
 * dozens of workers, and under CPU starvation its machinery wedged without ever invoking the
 * callback, leaving an unsettleable promise (the editor's eternal "Loading plates…"). Here the
 * whole operation is ONE task in ONE worker that the client (`zipArchiveClient.ts`, the
 * counterpart that owns the deadline + main-thread fallback) terminates deterministically.
 *
 * Inputs arrive structured-cloned, never transferred: zip entries can be views into a LIVE open
 * archive, and detaching those buffers would corrupt the project they came from. Outputs are
 * worker-owned, so their buffers transfer back zero-copy.
 */
/// <reference lib="webworker" />
import { unzipSync, zipSync } from 'fflate'

/** fflate's compression-level range. */
export type ZipCompressionLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

export type ZipArchiveRequest =
  | { op: 'unzip'; bytes: Uint8Array }
  | { op: 'zip'; entries: Record<string, Uint8Array>; level: ZipCompressionLevel }

export type ZipArchiveResponse =
  | { ok: true; entries: Record<string, Uint8Array> }
  | { ok: true; bytes: Uint8Array }
  | { ok: false; error: string }

const ctx = self as unknown as DedicatedWorkerGlobalScope

/** Every distinct backing buffer, deduped: listing one twice makes postMessage throw. */
function buffersOf(views: Iterable<Uint8Array>): ArrayBuffer[] {
  return [...new Set([...views].map((view) => view.buffer as ArrayBuffer))]
}

ctx.onmessage = (event: MessageEvent<ZipArchiveRequest>) => {
  const request = event.data
  try {
    if (request.op === 'unzip') {
      const entries = unzipSync(request.bytes)
      ctx.postMessage({ ok: true, entries } satisfies ZipArchiveResponse, buffersOf(Object.values(entries)))
    } else {
      const bytes = zipSync(request.entries, { level: request.level })
      ctx.postMessage({ ok: true, bytes } satisfies ZipArchiveResponse, buffersOf([bytes]))
    }
  } catch (error) {
    // A thrown codec error is a DATA problem (corrupt zip, bad entry): report it as a result so
    // the client rejects with the real message instead of falling back to re-fail on the main thread.
    ctx.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies ZipArchiveResponse)
  }
}
