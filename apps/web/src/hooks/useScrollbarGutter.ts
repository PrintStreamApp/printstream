/**
 * Scrollbar-gutter bookkeeping for a scroll container.
 *
 * Owns the rule that a gutter is reserved only when the content ACTUALLY overflows. A container
 * that reserves `scrollbar-gutter: stable` unconditionally is inset on the right by the width of a
 * scrollbar that never appears, which reads as a lopsided dialog. Reserving it once overflow is
 * real is what stops the content shifting sideways as a scrollbar appears mid-interaction.
 *
 * Callers spread `scrollAreaSx` onto the scroll container, hand it `scrollRef`, and spread
 * `contentSx` onto a single wrapper INSIDE it (the small inline padding that keeps rows off the
 * scrollbar has to sit on the content, not on the scrolling box, or it scrolls away).
 *
 * `ScrollableDialogBody` is the packaged form of that pairing; call this hook directly only for a
 * scroll container that cannot be one (e.g. a `TabPanel` that must itself be the scroll region so
 * a sticky toolbar inside it pins to the panel's top).
 */
import { useLayoutEffect, useState } from 'react'

/** Sub-pixel layout rounding routinely leaves a hairline of "overflow" that no scrollbar shows for. */
const OVERFLOW_TOLERANCE_PX = 1

export interface ScrollbarGutter {
  /** Attach to the scroll container. A callback ref, so remount (e.g. a tab switch) re-measures. */
  scrollRef: (node: HTMLElement | null) => void
  /** True once the container's content is taller than the container. */
  hasVerticalOverflow: boolean
  /** Overflow + gutter styles for the scroll container. */
  scrollAreaSx: { overflowY: 'auto' | 'hidden'; scrollbarGutter: 'stable' | 'auto' }
  /** Styles for the wrapper inside it: keeps content off the scrollbar, only when there is one. */
  contentSx: { minWidth: 0; pr: number }
}

/**
 * @param watch value to re-measure on beyond size changes: pass the rendered `children` so a
 * content swap that keeps the same box size (a tab's rows replaced by an empty state) is caught.
 * Size changes are observed directly and need no help.
 */
export function useScrollbarGutter(watch?: unknown): ScrollbarGutter {
  // The element lives in state, not a ref, so attaching it re-runs the measurement, a ref would
  // still be null on the render that mounts the container.
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [hasVerticalOverflow, setHasVerticalOverflow] = useState(false)

  // Layout effect, so the first measurement lands before paint: an effect would show one frame of
  // the wrong gutter on every open, which is exactly the sideways jump this hook exists to avoid.
  useLayoutEffect(() => {
    if (!element) {
      setHasVerticalOverflow(false)
      return undefined
    }

    let frame = 0
    const measure = () => {
      setHasVerticalOverflow(element.scrollHeight - element.clientHeight > OVERFLOW_TOLERANCE_PX)
    }
    // Observer callbacks arrive in bursts (one per observed child); coalesce them into one frame.
    const scheduleMeasure = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(measure)
    }

    measure()
    window.addEventListener('resize', scheduleMeasure)

    // Observe the children too: the container's own box often stays fixed while its content grows.
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleMeasure) : null
    resizeObserver?.observe(element)
    for (const child of Array.from(element.children)) {
      resizeObserver?.observe(child)
    }

    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', scheduleMeasure)
      resizeObserver?.disconnect()
    }
  }, [element, watch])

  return {
    scrollRef: setElement,
    hasVerticalOverflow,
    scrollAreaSx: {
      overflowY: hasVerticalOverflow ? 'auto' : 'hidden',
      scrollbarGutter: hasVerticalOverflow ? 'stable' : 'auto'
    },
    contentSx: { minWidth: 0, pr: hasVerticalOverflow ? 0.75 : 0 }
  }
}
