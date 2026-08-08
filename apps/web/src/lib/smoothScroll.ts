/**
 * Smoothly scrolls the document so an element's top aligns with the viewport,
 * honouring the element's CSS `scroll-margin-top`.
 *
 * Implemented as a manual `requestAnimationFrame` animation that writes the
 * scroller's `scrollTop` directly, rather than `scrollIntoView({behavior:'smooth'})`
 * or CSS `scroll-behavior: smooth`, because both of those snap instantly in two
 * situations the app's in-page jumps (SectionNav, pagination) kept hitting:
 *  - Chromium honours `scrollIntoView({behavior:'smooth'})` unreliably for the
 *    document scroller, and
 *  - CSS `scroll-behavior: smooth` and explicit JS smooth are forced to instant
 *    when the environment reports `prefers-reduced-motion: reduce` (some embedded
 *    browsers report this by default).
 *
 * Writing `scrollTop` per frame is immune to both, so these deliberate,
 * user-triggered navigation jumps animate everywhere. A direct property write is
 * also unaffected by any ambient `scroll-behavior`, so there is no double-animation.
 */
const SCROLL_DURATION_MS = 320

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2
}

export function smoothScrollToElement(element: Element): void {
  if (typeof window === 'undefined') return
  const scroller = document.scrollingElement ?? document.documentElement
  const marginTop = Number.parseFloat(getComputedStyle(element).scrollMarginTop) || 0
  const startTop = scroller.scrollTop
  const maxTop = scroller.scrollHeight - scroller.clientHeight
  const targetTop = Math.max(0, Math.min(startTop + element.getBoundingClientRect().top - marginTop, maxTop))
  const distance = targetTop - startTop
  if (Math.abs(distance) < 1) return

  let startTime: number | null = null
  const step = (now: number) => {
    if (startTime === null) startTime = now
    const progress = Math.min(1, (now - startTime) / SCROLL_DURATION_MS)
    scroller.scrollTop = startTop + distance * easeInOutQuad(progress)
    if (progress < 1) window.requestAnimationFrame(step)
  }
  window.requestAnimationFrame(step)
}

/**
 * Shorter than a page jump: stepping a carousel one card is a small, repeatable
 * move, and page-length easing makes it feel sluggish when clicked repeatedly.
 */
const CAROUSEL_DURATION_MS = 220

/**
 * Horizontally scroll a container to `targetLeft`, for the same reasons the
 * vertical helper exists: `scrollTo({ behavior: 'smooth' })` is forced to
 * instant wherever the environment reports `prefers-reduced-motion: reduce`,
 * which some embedded browsers do by default, so carousel arrows snapped.
 *
 * Writing `scrollLeft` per frame animates everywhere and is unaffected by any
 * ambient `scroll-behavior`, so there is no double-animation.
 *
 * **The caller must lift `scroll-snap-type` for the duration.** A mandatory
 * snap re-snaps after every scroll write, which drags each intermediate frame
 * straight to the target and turns this back into a jump. `onDone` exists so
 * the caller can restore snapping once the animation lands.
 */
export function smoothScrollLeftTo(
  scroller: Element,
  targetLeft: number,
  options: { durationMs?: number; onDone?: () => void } = {}
): void {
  const { durationMs = CAROUSEL_DURATION_MS, onDone } = options
  if (typeof window === 'undefined') {
    onDone?.()
    return
  }
  const startLeft = scroller.scrollLeft
  const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth)
  const distance = Math.max(0, Math.min(targetLeft, maxLeft)) - startLeft
  if (Math.abs(distance) < 1) {
    onDone?.()
    return
  }

  let startTime: number | null = null
  const step = (now: number) => {
    if (startTime === null) startTime = now
    const progress = Math.min(1, (now - startTime) / durationMs)
    scroller.scrollLeft = startLeft + distance * easeInOutQuad(progress)
    if (progress < 1) {
      window.requestAnimationFrame(step)
      return
    }
    onDone?.()
  }
  window.requestAnimationFrame(step)
}
