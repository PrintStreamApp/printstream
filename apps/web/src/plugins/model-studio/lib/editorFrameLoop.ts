/**
 * Schedules the editor viewport's on-demand frames and placement checks.
 * The viewport owns the camera, drawing, and scene resources. This controller owns the
 * idle repaint interval, drag-end edge, validation cadence, and animation-frame cleanup.
 */
const IDLE_RENDER_INTERVAL_MS = 250
const PLACEMENT_CHECK_INTERVAL_FRAMES = 15

interface EditorFrameLoopOptions {
  isCovered: () => boolean
  advanceCamera: (now: number) => boolean
  isInteracting: () => boolean
  render: (interacting: boolean, dragJustEnded: boolean) => boolean
  recomputePlacementWarnings: () => void
}

/**
 * Create the frame scheduler without starting it. `render` returns true when a deferred
 * visual update needs one more frame. Calls to `requestRender` remain valid until `dispose`.
 */
export function createEditorFrameLoop(options: EditorFrameLoopOptions) {
  let frame: number | null = null
  let started = false
  let validationFrame = 0
  let wasInteracting = false
  let needsRender = true
  let lastRenderStamp = Number.NEGATIVE_INFINITY

  const requestRender = () => { needsRender = true }

  const animate = (now = 0) => {
    if (options.isCovered()) {
      frame = requestAnimationFrame(animate)
      return
    }

    // The camera advances even on frames that need no draw, so orbit damping stays smooth.
    const tweening = options.advanceCamera(now)
    const interacting = options.isInteracting()
    const dragJustEnded = wasInteracting && !interacting
    wasInteracting = interacting

    const shouldRender = needsRender
      || interacting
      || tweening
      || dragJustEnded
      || now - lastRenderStamp >= IDLE_RENDER_INTERVAL_MS
    if (shouldRender) {
      needsRender = options.render(interacting, dragJustEnded)
      lastRenderStamp = now
    }

    // Advisory placement work runs at low frequency while idle, and immediately on release.
    validationFrame += 1
    if (!interacting && (dragJustEnded || validationFrame % PLACEMENT_CHECK_INTERVAL_FRAMES === 0)) {
      options.recomputePlacementWarnings()
    }
    frame = requestAnimationFrame(animate)
  }

  return {
    requestRender,
    start: () => {
      if (started) return
      started = true
      animate()
    },
    dispose: () => {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
    }
  }
}
