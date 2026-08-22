/**
 * Main-thread client for `importStagingWorker.ts` — staging an import's geometry off-thread.
 *
 * Owns the worker's lifetime, the per-task deadline, and the fallback, so `localImportStore` only
 * has to ask for a mesh.
 *
 * The worker is PERSISTENT, unlike `zipArchiveClient`'s one-shot-per-operation worker, for one
 * reason: the STEP tessellator is a ~7 MB WASM instance and a fresh worker would re-download and
 * re-instantiate it on every import. It is created lazily (nothing is paid by a session that never
 * imports) and torn down on a deadline, so a wedged task still cannot leak — the next call simply
 * gets a new worker.
 *
 * Failure semantics, mirroring `zipArchiveClient`'s split:
 *  - DATA errors ({@link ImportStagingDataError}) are the file's fault and are NOT retried on the
 *    main thread — the same bytes would fail the same way, and doing it twice would freeze the tab
 *    on the way to the identical message.
 *  - MECHANISM failures (no `Worker`, the module failing to load, the deadline expiring) reject
 *    plainly, and the caller falls back to the main-thread path. Node tests take this path by
 *    design, which is why the fallback only warns when a worker was actually attempted.
 */
import type { ImportedMesh } from '@printstream/shared/three-mf'
import type { ImportStagingRequest, ImportStagingResponse } from './importStagingWorker'

/** Geometry ready to stage: the mesh the bake consumes plus the STL the viewport loads. */
export interface StagedImportGeometry {
  mesh: ImportedMesh
  stl: Uint8Array
  /** Binary STL per solid, aligned with `mesh.parts`. Empty when the import is a single mesh. */
  partStls: Uint8Array[]
}

/** The FILE could not be staged. Never retried on the main thread; the message is user-facing. */
export class ImportStagingDataError extends Error {}

/** Floor of the per-task deadline, so a small file still absorbs worker spawn + WASM load. */
export const IMPORT_STAGING_BASE_DEADLINE_MS = 60_000

/**
 * Deadline for one staging task, scaled by payload size: the base plus ~2ms per KB. Generous
 * because a STEP's cost is in tessellation rather than bytes (a small file can produce millions of
 * triangles), while still bounding a wedged worker to minutes rather than forever.
 */
export function importStagingDeadlineMs(byteLength: number): number {
  return IMPORT_STAGING_BASE_DEADLINE_MS + Math.ceil(byteLength / 512)
}

let worker: Worker | null = null
let nextRequestId = 1
const pending = new Map<number, (response: ImportStagingResponse) => void>()

/** Drop the worker so the next task starts a fresh one (after a deadline, or a worker-level error). */
function discardWorker(reason: string): void {
  worker?.terminate()
  worker = null
  for (const settle of pending.values()) {
    settle({ id: 0, ok: false, error: reason, dataError: false })
  }
  pending.clear()
}

function ensureWorker(): Worker {
  if (worker) return worker
  if (typeof Worker === 'undefined') throw new Error('Worker is unavailable in this environment')
  const created = new Worker(new URL('./importStagingWorker.ts', import.meta.url), { type: 'module' })
  created.onmessage = (event: MessageEvent<ImportStagingResponse>) => {
    const settle = pending.get(event.data.id)
    if (!settle) return
    pending.delete(event.data.id)
    settle(event.data)
  }
  created.onerror = (event) => {
    // Worker-level failure (bundle/load): every in-flight task falls back rather than hanging.
    discardWorker(event.message || 'Import staging worker error')
  }
  worker = created
  return created
}

/**
 * Release the staging worker, if one was started.
 *
 * Worth doing rather than leaving it to page teardown: the worker holds an instantiated OpenCASCADE
 * runtime (~7 MB) once a STEP has been imported, and an editor session that has closed has no use
 * for it. The next import simply starts a fresh worker. In-flight tasks fall back to the main
 * thread, as they do for any other worker-level failure.
 */
export function disposeImportStagingWorker(): void {
  if (worker) discardWorker('Import staging worker was disposed')
}

/**
 * Stage a picked file's geometry, off the main thread where possible.
 *
 * @throws {ImportStagingDataError} when the file itself cannot be staged — do not retry.
 * @throws {Error} when the worker mechanism failed — the caller should fall back.
 */
export async function stageImportGeometry(
  format: ImportStagingRequest['format'],
  bytes: Uint8Array
): Promise<StagedImportGeometry> {
  const active = ensureWorker()
  const id = nextRequestId
  nextRequestId += 1
  // Copy into a transferable buffer: the caller's bytes must survive for the fallback path, and a
  // transferred original would be detached out from under it.
  const transferable = bytes.slice().buffer

  const response = await new Promise<ImportStagingResponse>((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return
      // A worker that stopped answering cannot be trusted with the next import either.
      discardWorker('Import staging worker made no progress in time')
      resolve({ id, ok: false, error: 'Import staging worker made no progress in time', dataError: false })
    }, importStagingDeadlineMs(bytes.byteLength))
    pending.set(id, (message) => { clearTimeout(timer); resolve(message) })
    active.postMessage({ id, format, buffer: transferable } satisfies ImportStagingRequest, [transferable])
  })

  if (response.ok) return { mesh: response.mesh, stl: response.stl, partStls: response.partStls }
  if (response.dataError) throw new ImportStagingDataError(response.error)
  throw new Error(response.error)
}
