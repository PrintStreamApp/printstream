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
