/**
 * Yield until the browser has painted.
 *
 * Owns one rule: a click handler that flips a busy flag and then does heavy synchronous work in
 * the same task shows the user NOTHING. React commits the flag, but the browser never gets a frame
 * to paint the spinner before the work blocks the main thread, so the button looks unclicked for
 * however long the work takes and the user clicks it again.
 *
 * `requestAnimationFrame` fires just BEFORE a paint, so a timeout scheduled from inside it is the
 * first task that runs AFTER that paint. Awaiting this between "set busy" and "start work" is what
 * makes the busy state visible. Falls back to a plain timeout where rAF is unavailable (jsdom).
 *
 * Costs one frame (~16ms) — negligible against the work it precedes, and never worth adding to
 * work that is already fast.
 */
export function afterNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0)
      return
    }
    window.requestAnimationFrame(() => {
      window.setTimeout(resolve, 0)
    })
  })
}
