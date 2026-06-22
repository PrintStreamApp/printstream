/**
 * Robust termination for spawned slicer CLI children.
 *
 * Kept in its own module (not index.ts, which boots the HTTP server on import) so
 * the logic is unit-testable without starting the service.
 */

/** Minimal child surface this needs, so it is unit-testable with a fake. */
export interface TerminableChild {
  pid?: number
  kill(signal: NodeJS.Signals): boolean
}

/**
 * Terminate a slicer CLI child robustly: signal its process group (set up via
 * `detached` at spawn) so BambuStudio's Xvfb helpers go too, then escalate
 * SIGTERM -> SIGKILL after a grace period in case the CLI ignores SIGTERM.
 * Returns a canceller the caller invokes on the child's `close` so a clean exit
 * doesn't later SIGKILL a recycled PID. The `killGroup`/`graceMs`/`log` seams
 * keep it testable without a real process.
 */
export function terminateSlicerChild(
  child: TerminableChild,
  options: { graceMs?: number; log?: (message: string) => void; killGroup?: (pid: number, signal: NodeJS.Signals) => void } = {}
): () => void {
  const graceMs = options.graceMs ?? 5_000
  const log = options.log ?? ((message) => console.warn(message))
  const killGroup = options.killGroup ?? ((pid, signal) => {
    try {
      process.kill(-pid, signal)
    } catch {
      // The group may already be gone, or `detached` was not honored on this OS.
    }
  })
  const sendSignal = (signal: NodeJS.Signals): void => {
    if (typeof child.pid === 'number') killGroup(child.pid, signal)
    try {
      child.kill(signal)
    } catch {
      // Child already exited.
    }
  }

  sendSignal('SIGTERM')
  const escalation = setTimeout(() => {
    log('[slicer:executeCli] CLI did not exit after SIGTERM; sending SIGKILL')
    sendSignal('SIGKILL')
  }, graceMs)
  escalation.unref()

  return () => clearTimeout(escalation)
}
