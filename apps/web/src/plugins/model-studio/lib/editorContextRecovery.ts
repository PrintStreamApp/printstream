/**
 * Owns the editor canvas's WebGL context-loss listener and its rebuild rate limit.
 *
 * `useEditorScene` removes this listener before deliberately releasing a context at teardown.
 * A second loss within 30 seconds does not schedule another renderer that the device may be
 * unable to host; the first loss still prevents the browser's default permanent loss behavior.
 */
interface ContextRecoveryOptions {
  canvas: HTMLCanvasElement
  lastRebuildRef: { current: number }
  onRebuild: () => void
  now?: () => number
}

const MIN_REBUILD_INTERVAL_MS = 30_000

/** Install context recovery for one canvas and return its matching cleanup. */
export function installEditorContextRecovery({
  canvas,
  lastRebuildRef,
  onRebuild,
  now = Date.now
}: ContextRecoveryOptions): () => void {
  const onContextLost = (event: Event) => {
    event.preventDefault()
    const timestamp = now()
    if (timestamp - lastRebuildRef.current < MIN_REBUILD_INTERVAL_MS) return
    lastRebuildRef.current = timestamp
    onRebuild()
  }
  canvas.addEventListener('webglcontextlost', onContextLost)
  return () => canvas.removeEventListener('webglcontextlost', onContextLost)
}
