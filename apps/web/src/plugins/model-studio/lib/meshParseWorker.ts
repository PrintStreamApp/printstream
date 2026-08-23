/**
 * Web Worker that parses 3MF model entries / STL meshes off the main thread.
 *
 * A single 50 MB+ object would otherwise parse + weld + crease synchronously on the main thread
 * and freeze the editor for seconds (the "stuck at N of M" the progress counter shows). Here the
 * heavy work runs in a worker and only the finished geometry's typed arrays are transferred back
 * (zero-copy), so the UI stays responsive. See `meshParseCore.ts` (DOM-free) and the client
 * `meshParseClient.ts` (which owns the pool, the deadlines, and a main-thread fallback).
 *
 * This module owns the wire contract: `meshParseClient.ts` imports these types rather than
 * redeclaring them, so a change to a message shape cannot land on one side only.
 */
/// <reference lib="webworker" />
import { buildThreeMfGeometries, buildStlGeometry, type MeshPaintCodes } from './meshParseCore'

/** Client -> worker: one parse task. `buffer` is transferred, so the client sends a copy. */
export interface MeshParseRequest {
  id: number
  kind: 'threemf' | 'stl'
  buffer: ArrayBuffer
}

/** One parsed object's finished geometry, as arrays that transfer back without a copy. */
export interface ParsedMeshEntry {
  objectId: number
  position: Float32Array
  normal?: Float32Array
  supportPaint?: MeshPaintCodes
  seamPaint?: MeshPaintCodes
  colorPaint?: MeshPaintCodes
}

/**
 * Worker -> client: exactly one `ready` per worker, then one message per task.
 *
 * `dataError` says the BYTES failed, not the mechanism: the client uses it to decide whether a
 * main-thread retry could possibly do better. Anything thrown by the parsers is reported that way:
 * they are pure functions of their input, so a throw is the input's fault.
 */
export type MeshParseResponse =
  | { kind: 'ready' }
  | { kind: 'result'; id: number; entries: ParsedMeshEntry[] }
  | { kind: 'error'; id: number; error: string; dataError: boolean }

const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = (event: MessageEvent<MeshParseRequest>) => {
  const { id, kind, buffer } = event.data
  try {
    const entries: ParsedMeshEntry[] = []
    const transfer: ArrayBuffer[] = []
    const collect = (objectId: number, geometry: import('three').BufferGeometry) => {
      const position = geometry.getAttribute('position')?.array as Float32Array | undefined
      if (!position) return
      const normal = geometry.getAttribute('normal')?.array as Float32Array | undefined
      const entry: ParsedMeshEntry = {
        objectId,
        position,
        normal,
        supportPaint: geometry.userData.supportPaint as MeshPaintCodes | undefined,
        seamPaint: geometry.userData.seamPaint as MeshPaintCodes | undefined,
        colorPaint: geometry.userData.colorPaint as MeshPaintCodes | undefined
      }
      entries.push(entry)
      transfer.push(position.buffer as ArrayBuffer)
      if (normal && normal.buffer !== position.buffer) transfer.push(normal.buffer as ArrayBuffer)
    }

    if (kind === 'threemf') {
      const xml = new TextDecoder().decode(new Uint8Array(buffer))
      for (const [objectId, geometry] of buildThreeMfGeometries(xml)) collect(objectId, geometry)
    } else {
      collect(0, buildStlGeometry(buffer))
    }

    ctx.postMessage({ kind: 'result', id, entries } satisfies MeshParseResponse, transfer)
  } catch (error) {
    ctx.postMessage({
      kind: 'error',
      id,
      error: error instanceof Error ? error.message : 'Mesh parse failed',
      dataError: true
    } satisfies MeshParseResponse)
  }
}

// Announce readiness LAST, after the handler above is installed. This is the client's only proof
// that this worker's module graph actually evaluated: a worker that is constructed and then never
// runs (a dev module graph that fails to load, an attached-but-never-resumed debugger target, an
// extension that stalls it) is otherwise indistinguishable from a slow one, because `onerror` does
// not fire for any of them. Without this the client could only find out by waiting out a task
// deadline, per task.
ctx.postMessage({ kind: 'ready' } satisfies MeshParseResponse)
