/** Dedicated worker entry for paint-preserving mesh simplification. */
import { simplifyTriangleSoup, type SimplifyPaint, type SimplifySettings } from './meshSimplify'

export type MeshSimplifyWorkerRequest = {
  id: number
  soup: Float32Array
  paint: SimplifyPaint
  settings: SimplifySettings
}

export type MeshSimplifyWorkerResponse =
  | { kind: 'ready' }
  | { kind: 'result'; id: number; result: Awaited<ReturnType<typeof simplifyTriangleSoup>> }
  | { kind: 'error'; id: number; message: string }

self.postMessage({ kind: 'ready' } satisfies MeshSimplifyWorkerResponse)
self.onmessage = async (event: MessageEvent<MeshSimplifyWorkerRequest>) => {
  const { id, soup, paint, settings } = event.data
  try {
    const result = await simplifyTriangleSoup(soup, paint, settings)
    self.postMessage({ kind: 'result', id, result } satisfies MeshSimplifyWorkerResponse, [result.soup.buffer])
  } catch (error) {
    self.postMessage({
      kind: 'error',
      id,
      message: error instanceof Error ? error.message : 'Unable to simplify this mesh.'
    } satisfies MeshSimplifyWorkerResponse)
  }
}
