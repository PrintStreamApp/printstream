/**
 * Cross-viewer suspension signal for the model-studio plugin.
 *
 * A heavy overlay viewer (the 3D preview modal) acquires a hold while it owns a live
 * WebGL renderer; the editor's always-on render loop checks the count each frame and
 * skips its per-frame work while a hold is active, so two full scenes never render
 * simultaneously when one completely covers the other. Deliberately tiny module state
 * (no React) so both the hook-based editor loop and the preview's effect can use it.
 */

let holds = 0

/**
 * Register an active overlay viewer. Returns a release function; releasing twice is a
 * no-op so effect-cleanup ordering can't underflow the count.
 */
export function acquireOverlayViewerHold(): () => void {
  holds += 1
  let released = false
  return () => {
    if (released) return
    released = true
    holds -= 1
  }
}

/** True while any overlay viewer holds the signal (checked per frame by the editor loop). */
export function hasActiveOverlayViewer(): boolean {
  return holds > 0
}
