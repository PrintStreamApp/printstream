/**
 * Web Worker that evaluates a mesh boolean off the main thread.
 *
 * A union of two real models is seconds of synchronous work: `three-bvh-csg` builds a BVH and a
 * half-edge map per operand, then splits and re-triangulates. On the main thread that is a frozen
 * tab in which the Apply button's own spinner cannot paint, which is the failure `importStaging`,
 * `meshParse` and `zipArchive` all already have workers for. This is the fourth.
 *
 * This module owns the wire contract: `meshBooleanClient.ts` imports these types rather than
 * redeclaring them, so a change to a message shape cannot land on one side only.
 *
 * Soups cross as transferred `ArrayBuffer`s in both directions (zero-copy). The client sends copies,
 * because transferring detaches the caller's buffers and the operands are the live scene's geometry.
 */
/// <reference lib="webworker" />
import { evaluateMeshBooleanSoups, MeshBooleanOpenOperandError } from './meshBooleanCore'
import type { MeshBooleanOperation } from './meshBoolean'

/** Client -> worker: one evaluation. Every buffer is transferred, so the client sends copies. */
export interface MeshBooleanRequest {
  id: number
  operation: MeshBooleanOperation
  listA: ArrayBuffer[]
  listB: ArrayBuffer[]
}

/**
 * Worker -> client: exactly one `ready` per worker, then one message per task.
 *
 * `dataError` says the GEOMETRY defeated the evaluator, not that the mechanism failed. The client
 * does NOT retry those on the main thread: the fallback is the same `evaluateMeshBooleanSoups`, so
 * a retry would freeze the tab on its way to the identical message. Mechanism failures never reach
 * here at all -- they are the client noticing that nothing came back.
 *
 * `openOperand` is that same refusal with the one fact an `Error` cannot carry across a structured
 * clone: WHICH operand failed, as an index into `listA` then `listB`. The worker knows the index and
 * not the name; the caller knows the name and not the index.
 */
export type MeshBooleanResponse =
  | { kind: 'ready' }
  | { kind: 'done'; id: number; soup: ArrayBuffer }
  | { kind: 'dataError'; id: number; message: string }
  | { kind: 'openOperand'; id: number; operandIndex: number }

const context = globalThis as unknown as DedicatedWorkerGlobalScope

context.onmessage = (event: MessageEvent<MeshBooleanRequest>) => {
  const { id, operation, listA, listB } = event.data
  void (async () => {
    try {
      const soup = await evaluateMeshBooleanSoups(
        operation,
        listA.map((buffer) => new Float32Array(buffer)),
        listB.map((buffer) => new Float32Array(buffer))
      )
      // `soup.buffer` is this worker's own allocation, so transferring it costs nothing and cannot
      // detach anything the client still holds.
      const response: MeshBooleanResponse = { kind: 'done', id, soup: soup.buffer as ArrayBuffer }
      context.postMessage(response, [soup.buffer as ArrayBuffer])
    } catch (error) {
      const response: MeshBooleanResponse = error instanceof MeshBooleanOpenOperandError
        ? { kind: 'openOperand', id, operandIndex: error.operandIndex }
        : {
            kind: 'dataError',
            id,
            message: error instanceof Error ? error.message : 'The boolean could not be evaluated.'
          }
      context.postMessage(response)
    }
  })()
}

// The handshake the client waits for before dispatching anything. A worker can be constructed
// successfully and then never execute a line (a dev graph that fails to load, a debugger that
// attaches the target and never resumes it), and `onerror` fires for none of those -- so silence
// is the only symptom, and readiness has to be proved rather than assumed. See `meshParseClient`.
const ready: MeshBooleanResponse = { kind: 'ready' }
context.postMessage(ready)
