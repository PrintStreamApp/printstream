/**
 * Web Worker that turns a picked file into a staged import's geometry, off the main thread.
 *
 * Everything expensive about an import lives here: OCCT tessellating a STEP (WASM, seconds for a
 * real assembly), regex-parsing a 3MF's mesh XML into millions of vertices, the vertex weld, and
 * serializing the result to binary STL. On the main thread that is a frozen tab with a spinner that
 * never paints — the same failure `meshParseWorker.ts` was written for, and the public editor's
 * import path was the one geometry path still doing it inline.
 *
 * The 3MF branch unzips SYNCHRONOUSLY (fflate's sync codec) because it is already off the main
 * thread; that is what `zipArchiveWorker.ts` does for the same reason. It then wraps the entries
 * with the shared `threeMfArchiveFromEntries`, so the archive accessors have one implementation
 * rather than a worker-local copy.
 *
 * Failure semantics matter to the client and are split deliberately:
 *  - `dataError: true` — the FILE is the problem (no geometry, over the triangle cap, not a ZIP,
 *    OCCT refused it). Re-running on the main thread would fail identically, so the client must not.
 *  - `dataError: false` — the MECHANISM failed (module load, OOM). The client falls back to the
 *    main-thread path, which is a brief freeze rather than a failed import.
 *
 * Counterpart: `importStagingClient.ts` (owns the worker lifetime, deadline, and fallback).
 */
/// <reference lib="webworker" />
import { unzipSync } from 'fflate'
import {
  ThreeMfImportError,
  extractThreeMfImportMesh,
  meshToBinaryStl,
  parseStlMesh,
  stepMeshFromOcctResult,
  type ImportedMesh
} from '@printstream/shared/three-mf'
import { ThreeMfArchiveError, assertThreeMfSizeWithinLimit, threeMfArchiveFromEntries } from './threeMfArchive'
import { threeMfArchiveImportSource } from './localThreeMfImport'
import { loadOcctReader } from './occtLoader'

export interface ImportStagingRequest {
  id: number
  format: 'stl' | 'step' | '3mf'
  buffer: ArrayBuffer
}

export type ImportStagingResponse =
  | {
      id: number
      ok: true
      mesh: ImportedMesh
      /** Binary STL of the merged mesh — what the viewport loads for a single-solid import. */
      stl: Uint8Array
      /**
       * Binary STL per solid, aligned with `mesh.parts`. Serialized HERE rather than by the store:
       * an assembly's parts are the same triangles again, so doing it on the main thread put the
       * whole mesh through a second serialization pass in the middle of the import.
       */
      partStls: Uint8Array[]
    }
  | { id: number; ok: false; error: string; dataError: boolean }

const ctx = self as unknown as DedicatedWorkerGlobalScope

/**
 * Errors that describe the FILE rather than the runtime. `ThreeMfImportError` and
 * `ThreeMfArchiveError` are the vetted user-facing refusals; the rest are thrown by the shared
 * parsers for input they cannot use, and re-running any of them on the main thread would only
 * produce the same message a second time.
 */
function isDataError(error: unknown): boolean {
  if (error instanceof ThreeMfImportError || error instanceof ThreeMfArchiveError) return true
  if (!(error instanceof Error)) return false
  return /too large to import|contained no triangles|could not be tessellated|produced no geometry|invalid zip|not a zip/i
    .test(error.message)
}

async function stage(format: ImportStagingRequest['format'], bytes: Uint8Array): Promise<{ mesh: ImportedMesh; stl: Uint8Array }> {
  if (format === 'stl') {
    // The picked bytes ARE the STL the viewport loads; re-serializing would only churn memory.
    return { mesh: parseStlMesh(bytes), stl: bytes }
  }
  if (format === '3mf') {
    assertThreeMfSizeWithinLimit(bytes.byteLength)
    const archive = threeMfArchiveFromEntries(unzipSync(bytes))
    const mesh = await extractThreeMfImportMesh(threeMfArchiveImportSource(archive))
    return { mesh, stl: meshToBinaryStl(mesh) }
  }
  const read = await loadOcctReader()
  const mesh = stepMeshFromOcctResult(read(bytes))
  return { mesh, stl: meshToBinaryStl(mesh) }
}

ctx.onmessage = (event: MessageEvent<ImportStagingRequest>) => {
  const { id, format, buffer } = event.data
  void (async () => {
    try {
      const { mesh, stl } = await stage(format, new Uint8Array(buffer))
      const partStls = (mesh.parts ?? []).map((part) => meshToBinaryStl(part.mesh))
      // Every STL buffer is transferred (all freshly built here, nothing else references them); the
      // mesh's plain number arrays go by structured clone, which the bake needs them as.
      const transfer = [stl.buffer as ArrayBuffer, ...partStls.map((part) => part.buffer as ArrayBuffer)]
      ctx.postMessage({ id, ok: true, mesh, stl, partStls } satisfies ImportStagingResponse, transfer)
    } catch (error) {
      ctx.postMessage({
        id,
        ok: false,
        error: error instanceof Error ? error.message : 'Import failed',
        dataError: isDataError(error)
      } satisfies ImportStagingResponse)
    }
  })()
}
