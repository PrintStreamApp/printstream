/**
 * Main-thread client for the mesh-parse worker pool.
 *
 * Routes 3MF/STL geometry parsing to `meshParseWorker` so a huge object never freezes the editor,
 * and falls back to the synchronous parsers in `threeMfScene` when the worker mechanism fails — so
 * worker problems degrade to a slow load instead of a broken one. The worker returns finished
 * geometry as transferred typed arrays; we just rebuild the BufferGeometry.
 *
 * **Readiness is proved, never assumed.** A dedicated worker can be constructed successfully and
 * then never execute a line: a dev module graph that fails to load, a debugger or embedded webview
 * that attaches the worker target and never resumes it, an extension that stalls it. `onerror` is
 * silent for all of those, so the only symptom is that nothing ever comes back. The worker
 * therefore posts a `ready` handshake once its module has evaluated, and no task is dispatched
 * before it arrives. A pool that never reports ready is retired ONCE, for the session, after
 * {@link POOL_READY_TIMEOUT_MS} — every later parse then goes straight to the main thread. That is
 * the difference between one short wait per session and one multi-second wait PER MESH ENTRY,
 * followed by the main-thread parse anyway: opening an 8-entry project in such a browser used to
 * cost 8 x 20s of dead waiting before any geometry appeared.
 *
 * **A task's deadline measures only that task.** Callers parse a whole plate at once
 * (`threeMfSceneStream` awaits every entry in parallel) and a worker runs its messages one at a
 * time, so a deadline started at post time is mostly spent queued behind other entries. The client
 * keeps that queue itself and starts the clock when a worker actually takes the task.
 *
 * Failure semantics, mirroring `importStagingClient` / `zipArchiveClient`:
 *  - MECHANISM failures (no `Worker`, a never-ready pool, a worker-level error, a task deadline)
 *    fall back to a main-thread parse: a brief freeze beats a load that never finishes. Node tests
 *    take this path by design, which is why a pool that was never attempted stays quiet.
 *  - DATA failures are the file's fault. The STL path does NOT retry them, because
 *    `parseStlGeometry` is the same code as the worker's `buildStlGeometry` — the retry would fail
 *    identically, with a freeze on the way to the same message. The 3MF path DOES retry, because
 *    its fallback is a genuinely different reader (`DOMParser` against the worker's regex pass) and
 *    can succeed where the other could not.
 *
 * Counterpart: `meshParseWorker.ts`, which owns the message shapes imported below.
 */
import * as THREE from 'three'
import type { MeshParseRequest, MeshParseResponse, ParsedMeshEntry } from './meshParseWorker'
import { parseStlGeometry, parseThreeMfModelEntry } from './threeMfScene'

/** The FILE could not be parsed. Retried on the main thread only where that runs different code. */
export class MeshParseDataError extends Error {}

/**
 * How long a freshly built pool has to report ready before it is retired for the session.
 *
 * Sized to make a FALSE retirement impossible rather than to fail fast: a healthy pool never waits
 * for this (the handshake lands in ~0.7s even in dev, where the worker pulls three + three-stdlib
 * as unbundled dev chunks), and a broken one pays it once for the whole session — so headroom is
 * nearly free while retiring a working pool would cost main-thread parsing until the tab reloads.
 */
export const POOL_READY_TIMEOUT_MS = 5_000

/** Floor of a task's deadline, absorbing dispatch jitter on a loaded machine. */
export const MESH_PARSE_BASE_DEADLINE_MS = 15_000

/**
 * Deadline for one parse, scaled by input size: the base plus ~1ms per KB.
 *
 * Deliberately far above measured cost (an 11.5 MB mesh entry parses in ~0.8s) so this only trips
 * on a worker that has stopped making progress, never on a slow-but-working one. Same shape as
 * `importStagingDeadlineMs` / `zipArchiveDeadlineMs`.
 */
export function meshParseDeadlineMs(byteLength: number): number {
  return MESH_PARSE_BASE_DEADLINE_MS + Math.ceil(byteLength / 1024)
}

// A few workers so a slow 50MB parse doesn't block the others; capped low to leave the render
// thread + network headroom.
const POOL_SIZE = Math.max(1, Math.min(3, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1))

interface PoolWorker {
  worker: Worker
  /** Set by the worker's one-time handshake. Nothing is dispatched to a worker before this. */
  ready: boolean
  /** The task this worker is running. A worker handles one message at a time, by construction. */
  taskId: number | null
}

interface QueuedTask {
  id: number
  kind: MeshParseRequest['kind']
  /** Already a private copy, so transferring it cannot detach the caller's bytes. */
  buffer: ArrayBuffer
  deadlineMs: number
  resolve: (entries: ParsedMeshEntry[]) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

let pool: PoolWorker[] | null = null
let poolReady: Promise<void> | null = null
let signalPoolReady: (() => void) | null = null
/**
 * Rejects the readiness promise from OUTSIDE its executor.
 *
 * Without it, `retirePool` could drop the only handle to a promise callers were
 * already awaiting, leaving them parked until the readiness timer fired.
 */
let failPoolReady: ((error: Error) => void) | null = null
/** Non-null once the pool is out of the picture for good; also the reason, logged once. */
let unavailableReason: string | null = null
/** False until a `Worker` is actually constructed, so worker-less environments stay quiet. */
let workerWasAttempted = false
let nextRequestId = 1
const queued: QueuedTask[] = []
const inFlight = new Map<number, QueuedTask>()

function failTask(task: QueuedTask, reason: string): void {
  inFlight.delete(task.id)
  if (task.timer) clearTimeout(task.timer)
  task.timer = null
  task.reject(new Error(reason))
}

/**
 * Give up on workers for the rest of the session and drain everything to the main-thread fallback.
 *
 * Retiring rather than retrying is the point: every failure this handles is a property of the
 * environment (no `Worker`, a graph that will not load, a target that will not run), so re-probing
 * it per task only re-buys the same wait. Logged once, here, for the same reason.
 */
function retirePool(reason: string): void {
  if (!unavailableReason) {
    unavailableReason = reason
    if (workerWasAttempted) {
      console.warn(`[meshParse] ${reason}; parsing on the main thread for the rest of this session`)
    }
  }
  for (const entry of pool ?? []) entry.worker.terminate()
  pool = null
  // Settle the readiness promise before dropping it. Callers awaiting `ensurePool()`
  // are parked on that promise and are NOT in `queued`/`inFlight` yet (they only join
  // once it resolves), so the drain below does not reach them. Nulling the handles
  // without rejecting left them waiting for the readiness timeout instead of falling
  // back to the main thread the moment the pool died -- and reporting that timeout as
  // the reason rather than the worker error that actually happened.
  failPoolReady?.(new Error(reason))
  failPoolReady = null
  poolReady = null
  signalPoolReady = null
  const stranded = [...queued.splice(0), ...inFlight.values()]
  for (const task of stranded) failTask(task, reason)
}

function handleMessage(entry: PoolWorker, message: MeshParseResponse): void {
  if (message.kind === 'ready') {
    entry.ready = true
    signalPoolReady?.()
    pump()
    return
  }
  entry.taskId = null
  const task = inFlight.get(message.id)
  if (task) {
    inFlight.delete(message.id)
    if (task.timer) clearTimeout(task.timer)
    task.timer = null
    if (message.kind === 'result') task.resolve(message.entries)
    else task.reject(message.dataError ? new MeshParseDataError(message.error) : new Error(message.error))
  }
  pump()
}

function createPoolWorker(): PoolWorker {
  const worker = new Worker(new URL('./meshParseWorker.ts', import.meta.url), { type: 'module' })
  workerWasAttempted = true
  const entry: PoolWorker = { worker, ready: false, taskId: null }
  worker.onmessage = (event: MessageEvent<MeshParseResponse>) => handleMessage(entry, event.data)
  worker.onerror = (event) => {
    const reason = event.message || 'mesh parse worker error'
    // Whatever it was running died with it; that caller falls back rather than waiting the deadline.
    const task = entry.taskId == null ? undefined : inFlight.get(entry.taskId)
    entry.taskId = null
    if (task) failTask(task, reason)
    replaceWorker(entry, reason)
  }
  return entry
}

/**
 * Drop one worker and start a replacement in its slot.
 *
 * A worker that blew a size-scaled deadline, or raised a worker-level error after a sibling had
 * already proved the module graph loads, is a single casualty — the pool keeps working. A failure
 * BEFORE any worker has ever reported ready is different in kind (the graph itself is broken, so
 * the replacement would fail the same way) and retires the whole pool instead.
 */
function replaceWorker(entry: PoolWorker, reason: string): void {
  const workers = pool
  if (!workers) return
  if (!workers.some((candidate) => candidate.ready)) {
    retirePool(reason)
    return
  }
  const slot = workers.indexOf(entry)
  if (slot === -1) return
  entry.worker.terminate()
  try {
    workers[slot] = createPoolWorker()
  } catch {
    workers.splice(slot, 1)
    if (workers.length === 0) retirePool(reason)
  }
}

/** Resolves once at least one worker has proved it is executing; rejects if none ever does. */
function ensurePool(): Promise<void> {
  if (unavailableReason) return Promise.reject(new Error(unavailableReason))
  if (poolReady) return poolReady
  if (typeof Worker === 'undefined') {
    retirePool('Worker is unavailable in this environment')
    return Promise.reject(new Error(unavailableReason ?? 'Worker is unavailable in this environment'))
  }
  try {
    pool = Array.from({ length: POOL_SIZE }, () => createPoolWorker())
  } catch (error) {
    retirePool(error instanceof Error ? error.message : 'mesh parse workers could not be created')
    return Promise.reject(new Error(unavailableReason ?? 'mesh parse workers could not be created'))
  }
  poolReady = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const reason = `no mesh parse worker reported ready within ${POOL_READY_TIMEOUT_MS}ms`
      retirePool(reason)
      reject(new Error(reason))
    }, POOL_READY_TIMEOUT_MS)
    signalPoolReady = () => {
      clearTimeout(timer)
      signalPoolReady = null
      failPoolReady = null
      resolve()
    }
    failPoolReady = (error) => {
      clearTimeout(timer)
      reject(error)
    }
  })
  return poolReady
}

/** Hand queued tasks to idle, proven-ready workers. Safe to call whenever either side changes. */
function pump(): void {
  const workers = pool
  if (!workers) return
  for (const entry of workers) {
    if (entry.taskId != null || !entry.ready) continue
    const task = queued.shift()
    if (!task) return
    entry.taskId = task.id
    inFlight.set(task.id, task)
    // The clock starts HERE, not when the caller asked: waiting for a free worker is the pool's own
    // queue, and charging it to the task would time out a big plate's later entries for no reason
    // other than being later in the plate.
    task.timer = setTimeout(() => {
      const reason = `mesh parse worker made no progress within ${task.deadlineMs}ms`
      entry.taskId = null
      failTask(task, reason)
      replaceWorker(entry, reason)
    }, task.deadlineMs)
    entry.worker.postMessage(
      { id: task.id, kind: task.kind, buffer: task.buffer } satisfies MeshParseRequest,
      [task.buffer]
    )
  }
}

function runOnWorker(kind: MeshParseRequest['kind'], bytes: Uint8Array): Promise<ParsedMeshEntry[]> {
  return ensurePool().then(() => new Promise<ParsedMeshEntry[]>((resolve, reject) => {
    const id = nextRequestId
    nextRequestId += 1
    queued.push({
      id,
      kind,
      // Copy into a transferable buffer so the original bytes survive for the fallback path.
      buffer: bytes.slice().buffer,
      deadlineMs: meshParseDeadlineMs(bytes.byteLength),
      resolve,
      reject,
      timer: null
    })
    pump()
  }))
}

/** A retired pool has already explained itself once; do not repeat it per mesh entry. */
function warnFallback(context: string, error: unknown): void {
  if (unavailableReason) return
  console.warn(`[meshParse] ${context}; using main-thread fallback`, error)
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
    // Data failures are retried here too, unlike the STL path: the fallback is a DOM parse rather
    // than the worker's regex pass, so it reads entries the worker cannot (attributes out of the
    // order the regexes assume).
    warnFallback('3MF worker parse failed', error)
    return parseThreeMfModelEntry(new TextDecoder().decode(bytes))
  }
}

/** Parse a binary STL to geometry off the main thread (falls back to a synchronous main-thread parse). */
export async function parseStlGeometryAsync(bytes: Uint8Array): Promise<THREE.BufferGeometry> {
  try {
    const entries = await runOnWorker('stl', bytes)
    const entry = entries[0]
    if (!entry) throw new MeshParseDataError('Empty STL parse result')
    return reconstruct(entry)
  } catch (error) {
    // No main-thread retry for a bad file: `parseStlGeometry` IS the worker's `buildStlGeometry`,
    // so it would freeze the tab on its way to throwing the identical message.
    if (error instanceof MeshParseDataError) throw error
    warnFallback('STL worker parse failed', error)
    return parseStlGeometry(bytes.slice().buffer)
  }
}
