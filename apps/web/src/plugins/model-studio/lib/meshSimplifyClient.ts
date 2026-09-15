/**
 * Main-thread client for the simplify worker.
 *
 * Each preview owns one worker so changing a slider can terminate obsolete CPU work immediately.
 * Worker-less environments fall back to the same implementation on the main thread; an abort never
 * falls back, because it means a newer preview already superseded the result.
 */
import {
  simplifyTriangleSoup,
  type SimplifyPaint,
  type SimplifyResult,
  type SimplifySettings
} from './meshSimplify'
import type { MeshSimplifyWorkerRequest, MeshSimplifyWorkerResponse } from './meshSimplifyWorker'

let nextRequestId = 1

/** A deterministic worker result failure. Retrying it on the UI thread can only freeze the tab. */
class MeshSimplifyDataError extends Error {}

/** Simplify one volume, settling on result, abort, or a bounded worker-start failure. */
export async function simplifyMesh(
  soup: Float32Array,
  paint: SimplifyPaint,
  settings: SimplifySettings,
  signal?: AbortSignal
): Promise<SimplifyResult> {
  if (signal?.aborted) throw new DOMException('The simplification was cancelled.', 'AbortError')
  if (typeof Worker === 'undefined') return simplifyTriangleSoup(soup, paint, settings)

  const id = nextRequestId++
  let worker: Worker
  try {
    worker = new Worker(new URL('./meshSimplifyWorker.ts', import.meta.url), { type: 'module' })
  } catch (error) {
    console.warn('[meshSimplify] worker unavailable; using main-thread fallback', error)
    return simplifyTriangleSoup(soup, paint, settings)
  }

  try {
    return await new Promise<SimplifyResult>((resolve, reject) => {
      let ready = false
      let startupTimeout: number | null = null
      let abort = () => {}
      const settle = (action: () => void) => {
        if (startupTimeout != null) window.clearTimeout(startupTimeout)
        signal?.removeEventListener('abort', abort)
        action()
      }
      abort = () => settle(() => reject(new DOMException('The simplification was cancelled.', 'AbortError')))
      startupTimeout = window.setTimeout(() => {
        settle(() => reject(new Error('The simplification worker did not start.')))
      }, 10_000)
      signal?.addEventListener('abort', abort, { once: true })
      worker.onerror = (event) => settle(() => reject(new Error(event.message || 'The simplification worker failed.')))
      worker.onmessage = (event: MessageEvent<MeshSimplifyWorkerResponse>) => {
        const response = event.data
        if (response.kind === 'ready') {
          ready = true
          if (startupTimeout != null) window.clearTimeout(startupTimeout)
          startupTimeout = null
          const request: MeshSimplifyWorkerRequest = { id, soup: soup.slice(), paint, settings }
          worker.postMessage(request, [request.soup.buffer])
          return
        }
        if (!ready || response.id !== id) return
        if (response.kind === 'error') settle(() => reject(new MeshSimplifyDataError(response.message)))
        else settle(() => resolve(response.result))
      }
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    if (error instanceof MeshSimplifyDataError) throw error
    console.warn('[meshSimplify] worker unavailable or stalled; using main-thread fallback', error)
    return simplifyTriangleSoup(soup, paint, settings)
  } finally {
    worker.terminate()
  }
}
