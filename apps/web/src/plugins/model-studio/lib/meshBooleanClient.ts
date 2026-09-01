/**
 * Main-thread client for the mesh-boolean worker.
 *
 * Routes the CSG evaluation to `meshBooleanWorker` so combining two real models never freezes the
 * editor, and falls back to the same evaluation on the main thread when the worker MECHANISM is
 * unavailable, so worker problems degrade to a brief freeze rather than a tool that does nothing.
 *
 * Three things it does NOT copy from `meshParseClient`, each for a reason:
 *
 *  - **One worker, not a pool.** A boolean is a single user action with a single Apply button; there
 *    is never a second task to run beside it, and a pool would only hold idle workers with the
 *    ~7MB `three` + `three-bvh-csg` module graph resident.
 *  - **Created on first use and kept.** The graph is heavy enough that per-apply construction would
 *    put the load cost back into the operation it exists to speed up, and cheap enough to keep for a
 *    session that has run one boolean.
 *  - **A DATA failure is never retried.** The fallback runs `evaluateMeshBooleanSoups`, the very
 *    code the worker ran, so a retry buys the identical message at the price of the freeze. Only a
 *    mechanism failure falls back, which is also the path every node test takes (no `Worker` there).
 *
 * Counterpart: `meshBooleanWorker.ts`, which owns the message shapes imported below.
 */
import { evaluateMeshBooleanSoups, MeshBooleanDataError, MeshBooleanOpenOperandError } from './meshBooleanCore'
import type { MeshBooleanOperation } from './meshBoolean'
import type { MeshBooleanRequest, MeshBooleanResponse } from './meshBooleanWorker'

/**
 * How long a freshly built worker has to report ready before workers are abandoned for the session.
 *
 * Sized so a FALSE abandonment is impossible rather than to fail fast: a healthy worker answers in
 * well under a second even in dev (where `three` and `three-bvh-csg` load as unbundled chunks),
 * while a broken environment pays this once for the whole session instead of once per apply.
 */
export const BOOLEAN_WORKER_READY_TIMEOUT_MS = 8_000

/** Floor of an evaluation's deadline, absorbing dispatch jitter on a loaded machine. */
export const BOOLEAN_BASE_DEADLINE_MS = 60_000

/**
 * Deadline for one evaluation, scaled by total input size: the base plus ~2ms per KB.
 *
 * Deliberately far above measured cost, because the only thing it must catch is a worker that has
 * stopped making progress. CSG is superlinear in triangle count and a boolean over two dense models
 * is legitimately slow, so a tight deadline here would abandon working evaluations and then repeat
 * them on the main thread, which is the freeze this module exists to avoid.
 */
export function meshBooleanDeadlineMs(byteLength: number): number {
  return BOOLEAN_BASE_DEADLINE_MS + Math.ceil(byteLength / 1024) * 2
}

interface PendingTask {
  resolve: (soup: Float32Array) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

let worker: Worker | null = null
let workerReady: Promise<void> | null = null
let signalReady: (() => void) | null = null
/** Rejects the readiness promise from OUTSIDE its executor, so retiring cannot strand an awaiter. */
let failReady: ((error: Error) => void) | null = null
/** Non-null once workers are out of the picture for good; also the reason, logged once. */
let unavailableReason: string | null = null
/** False until a `Worker` is actually constructed, so worker-less environments stay quiet. */
let workerWasAttempted = false
let nextRequestId = 1
const inFlight = new Map<number, PendingTask>()

/**
 * Give up on the worker for the rest of the session and drain everything to the main thread.
 *
 * For MECHANISM failures only -- it could not be constructed, it errored, it never reported ready.
 * A worker that has run is not retired for being SLOW: see {@link abandon}.
 */
function retire(reason: string): void {
  if (!unavailableReason) {
    unavailableReason = reason
    if (workerWasAttempted) {
      console.warn(`[meshBoolean] ${reason}; evaluating on the main thread for the rest of this session`)
    }
  }
  teardown(reason)
}

/**
 * Drop the worker and everything on it, but keep using workers.
 *
 * A task overrunning its deadline is not proof the worker is broken: the deadline is a guess
 * (60s plus a size term) and CSG cost is superlinear, so a genuinely heavy model can beat it while
 * the worker is working perfectly. Retiring on that turned one slow boolean into a session where
 * EVERY boolean ran on the main thread -- the frozen tab this module exists to prevent, arrived at
 * by the module's own safety valve. The runaway worker is still terminated (its work is
 * unreachable now, and it would keep a core busy), and the next call constructs a fresh one.
 */
function abandon(reason: string): void {
  if (workerWasAttempted) {
    console.warn(`[meshBoolean] ${reason}; evaluating this one on the main thread and retrying the worker next time`)
  }
  teardown(reason)
}

/** Terminate the worker, settle anyone waiting on it, and clear the handles. */
function teardown(reason: string): void {
  worker?.terminate()
  worker = null
  // Settle before dropping the handles: a caller parked on `ensureWorker()` has not joined
  // `inFlight` yet, so the drain below cannot reach it, and without this it would wait out the
  // readiness timeout instead of falling back the moment the worker died.
  failReady?.(new Error(reason))
  failReady = null
  signalReady = null
  workerReady = null
  for (const [id, task] of inFlight) {
    inFlight.delete(id)
    if (task.timer) clearTimeout(task.timer)
    task.reject(new Error(reason))
  }
}

function handleMessage(event: MessageEvent<MeshBooleanResponse>): void {
  const message = event.data
  if (message.kind === 'ready') {
    signalReady?.()
    signalReady = null
    failReady = null
    return
  }
  const task = inFlight.get(message.id)
  if (!task) return
  inFlight.delete(message.id)
  if (task.timer) clearTimeout(task.timer)
  if (message.kind === 'done') task.resolve(new Float32Array(message.soup))
  // Rebuilt rather than forwarded: a structured clone flattens the subclass, and the caller needs
  // the type to know it may name the operand instead of showing a bare message.
  else if (message.kind === 'openOperand') task.reject(new MeshBooleanOpenOperandError(message.operandIndex))
  else task.reject(new MeshBooleanDataError(message.message))
}

/** Build the worker (once) and resolve when it has proved it is running. */
function ensureWorker(): Promise<void> {
  if (unavailableReason) return Promise.reject(new Error(unavailableReason))
  if (workerReady) return workerReady
  if (typeof Worker === 'undefined') {
    retire('Workers are unavailable in this environment')
    return Promise.reject(new Error(unavailableReason!))
  }
  workerReady = new Promise<void>((resolve, reject) => {
    signalReady = resolve
    failReady = reject
    try {
      workerWasAttempted = true
      worker = new Worker(new URL('./meshBooleanWorker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = handleMessage
      worker.onerror = () => retire('The boolean worker failed to start')
    } catch {
      retire('The boolean worker could not be created')
      return
    }
    setTimeout(() => {
      if (signalReady) retire('The boolean worker never reported ready')
    }, BOOLEAN_WORKER_READY_TIMEOUT_MS)
  })
  return workerReady
}

/**
 * Evaluate one operation over two groups of WORLD-space soups.
 *
 * Same contract as the core it delegates to: `listB` is used by `difference` only, and an empty
 * result is a real answer (two shapes that do not touch have no intersection) which the caller must
 * not treat as failure without saying so.
 */
export async function evaluateMeshBoolean(
  operation: MeshBooleanOperation,
  listA: Float32Array[],
  listB: Float32Array[] = []
): Promise<Float32Array> {
  try {
    await ensureWorker()
  } catch {
    return evaluateMeshBooleanSoups(operation, listA, listB)
  }
  const active = worker
  if (!active) return evaluateMeshBooleanSoups(operation, listA, listB)

  const id = nextRequestId++
  // COPIES, not the caller's arrays: posting transfers the buffers, which would detach the live
  // scene geometry these soups were collected from.
  const copyOf = (soup: Float32Array) => soup.slice().buffer as ArrayBuffer
  const request: MeshBooleanRequest = {
    id,
    operation,
    listA: listA.map(copyOf),
    listB: listB.map(copyOf)
  }
  const bytes = [...listA, ...listB].reduce((total, soup) => total + soup.byteLength, 0)

  return new Promise<Float32Array>((resolve, reject) => {
    const task: PendingTask = { resolve, reject, timer: null }
    inFlight.set(id, task)
    task.timer = setTimeout(() => {
      if (inFlight.has(id)) abandon('The boolean worker overran its deadline')
    }, meshBooleanDeadlineMs(bytes))
    active.postMessage(request, [...request.listA, ...request.listB])
  }).catch((error) => {
    // A DATA failure is the geometry's, and the fallback is the same code: surface it.
    if (error instanceof MeshBooleanDataError) throw error
    // Anything else is the mechanism or a deadline, both already recorded by `retire`/`abandon`.
    // Run it here instead.
    return evaluateMeshBooleanSoups(operation, listA, listB)
  })
}
