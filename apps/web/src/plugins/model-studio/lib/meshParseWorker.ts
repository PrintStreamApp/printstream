/**
 * Web Worker that parses 3MF model entries / STL meshes off the main thread.
 *
 * A single 50 MB+ object would otherwise parse + weld + crease synchronously on the main thread
 * and freeze the editor for seconds (the "stuck at N of M" the progress counter shows). Here the
 * heavy work runs in a worker and only the finished geometry's typed arrays are transferred back
 * (zero-copy), so the UI stays responsive. See `meshParseCore.ts` (DOM-free) and the client
 * `meshParseClient.ts` (which owns the pool + a main-thread fallback).
 */
/// <reference lib="webworker" />
import { buildThreeMfGeometries, buildStlGeometry, type MeshPaintCodes } from './meshParseCore'

interface ParseRequest {
  id: number
  kind: 'threemf' | 'stl'
  buffer: ArrayBuffer
}

interface ParsedMeshEntry {
  objectId: number
  position: Float32Array
  normal?: Float32Array
  supportPaint?: MeshPaintCodes
  seamPaint?: MeshPaintCodes
  colorPaint?: MeshPaintCodes
}

const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = (event: MessageEvent<ParseRequest>) => {
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

    ctx.postMessage({ id, entries }, transfer)
  } catch (error) {
    ctx.postMessage({ id, error: error instanceof Error ? error.message : 'Mesh parse failed' })
  }
}
