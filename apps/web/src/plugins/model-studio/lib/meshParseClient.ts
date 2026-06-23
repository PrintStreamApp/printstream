/**
 * Main-thread client for the mesh-parse worker pool.
 *
 * Routes 3MF/STL geometry parsing to `meshParseWorker` so a huge object never freezes the editor,
 * and falls back to the synchronous DOM parser in `threeMfScene` if the worker is unavailable or
 * errors — so worker problems degrade to today's behaviour instead of breaking the load. The
 * worker returns finished geometry as transferred typed arrays; we just rebuild the BufferGeometry.
 */
import * as THREE from 'three'
import type { MeshPaintCodes } from './meshParseCore'
import { parseStlGeometry, parseThreeMfModelEntry } from './threeMfScene'

interface ParsedMeshEntry {
  objectId: number
  position: Float32Array
  normal?: Float32Array
  supportPaint?: MeshPaintCodes
  seamPaint?: MeshPaintCodes
  colorPaint?: MeshPaintCodes
}
interface WorkerResponse {
  id: number
  entries?: ParsedMeshEntry[]
  error?: string
}

// A few workers so a slow 50MB parse doesn't block the others; capped low to leave the render
// thread + network headroom.
const POOL_SIZE = Math.max(1, Math.min(3, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1))
let pool: Worker[] | null = null
let poolCursor = 0
let workersUnavailable = false
let nextRequestId = 1
const pending = new Map<number, { resolve: (entries: ParsedMeshEntry[]) => void; reject: (error: Error) => void }>()

function ensurePool(): Worker[] | null {
  if (workersUnavailable) return null
  if (pool) return pool
  try {
    pool = Array.from({ length: POOL_SIZE }, () => {
      const worker = new Worker(new URL('./meshParseWorker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const { id, entries, error } = event.data
        const request = pending.get(id)
        if (!request) return
        pending.delete(id)
        if (error || !entries) request.reject(new Error(error ?? 'Mesh parse failed'))
        else request.resolve(entries)
      }
      worker.onerror = (event) => {
        // Worker-level failure (bundle/load): disable the pool so every parse uses the fallback.
        console.warn('[meshParse] worker pool error; switching to main-thread parsing', event.message)
        workersUnavailable = true
        for (const request of pending.values()) request.reject(new Error('Mesh parse worker error'))
        pending.clear()
      }
      return worker
    })
  } catch {
    workersUnavailable = true
    pool = null
  }
  return pool
}

// A worker that was constructed but never answers (e.g. a dev module-worker whose module
// silently failed to load, where `onerror` never fires) would otherwise hang the parse
// forever. Bound each task so the caller can fall back to the main-thread parse. Set well
// above any real parse time (even large meshes finish in a few seconds) so it only trips on
// a wedged/never-started worker, not on a slow-but-working one.
const WORKER_TASK_TIMEOUT_MS = 20_000

function runOnWorker(kind: 'threemf' | 'stl', bytes: Uint8Array): Promise<ParsedMeshEntry[]> {
  const workers = ensurePool()
  if (!workers || workers.length === 0) return Promise.reject(new Error('No mesh parse worker'))
  const id = nextRequestId
  nextRequestId += 1
  // Copy into a transferable buffer so the original bytes survive for the fallback path.
  const transferable = bytes.slice().buffer
  const worker = workers[poolCursor % workers.length]!
  poolCursor += 1
  return new Promise<ParsedMeshEntry[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error('Mesh parse worker timed out'))
    }, WORKER_TASK_TIMEOUT_MS)
    pending.set(id, {
      resolve: (entries) => { clearTimeout(timer); resolve(entries) },
      reject: (error) => { clearTimeout(timer); reject(error) }
    })
    worker.postMessage({ id, kind, buffer: transferable }, [transferable])
  })
}

function reconstruct(entry: ParsedMeshEntry): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(entry.position, 3))
  if (entry.normal) geometry.setAttribute('normal', new THREE.BufferAttribute(entry.normal, 3))
  if (entry.supportPaint) geometry.userData.supportPaint = entry.supportPaint
  if (entry.seamPaint) geometry.userData.seamPaint = entry.seamPaint
  if (entry.colorPaint) geometry.userData.colorPaint = entry.colorPaint
  geometry.computeBoundingSphere()
  return geometry
}

/** Parse a 3MF model entry's objects to geometry off the main thread (falls back to DOM parse). */
export async function parseThreeMfModelEntryAsync(bytes: Uint8Array): Promise<Map<number, THREE.BufferGeometry>> {
  try {
    const entries = await runOnWorker('threemf', bytes)
    const geometries = new Map<number, THREE.BufferGeometry>()
    for (const entry of entries) geometries.set(entry.objectId, reconstruct(entry))
    return geometries
  } catch (error) {
    console.warn('[meshParse] 3MF worker parse failed; using main-thread fallback', error)
    return parseThreeMfModelEntry(new TextDecoder().decode(bytes))
  }
}

/** Parse a binary STL to geometry off the main thread (falls back to a synchronous main-thread parse). */
export async function parseStlGeometryAsync(bytes: Uint8Array): Promise<THREE.BufferGeometry> {
  try {
    const entries = await runOnWorker('stl', bytes)
    const entry = entries[0]
    if (!entry) throw new Error('Empty STL parse result')
    return reconstruct(entry)
  } catch (error) {
    console.warn('[meshParse] STL worker parse failed; using main-thread fallback', error)
    return parseStlGeometry(bytes.slice().buffer)
  }
}
