/**
 * Fits a nav row to the space it actually has, by stepping DOWN through
 * density levels until its content stops overflowing.
 *
 * The problem this solves is one CSS alone cannot: how much room a tab row
 * needs depends on how many tabs it has and how long their words are, and both
 * are decided at runtime (a plugin adds a tab, the platform nav carries six,
 * a workspace nav carries four). A media query only knows the viewport, so it
 * would have to be tuned for the worst case and would waste space in every
 * other one.
 *
 * The ladder is deliberately lossless before it is lossy: the first three rungs
 * spend only padding and gap, so every label still reads at full size; the
 * fourth drops a type step; `icons` is the first that hides anything, and is
 * only reached when the words genuinely will not fit. Truncating labels is NOT
 * a level — a row of half-words is unreadable in a way that a row of icons is
 * not, and the icons keep their meaning through the tooltip.
 *
 * The row's own `overflowX: auto` remains the final backstop below `icons`.
 *
 * Contract: the caller puts `ref` on the SCROLL CONTAINER (the element whose
 * `scrollWidth` overflows) and styles its descendants from the
 * `data-nav-density` attribute this writes. The returned `density` is for
 * callers that must change what they RENDER rather than how it looks — the
 * tooltip has to name a tab whose label is hidden. Layout must be driven by
 * the attribute, not by that value: the fitting loop measures inside one
 * layout pass, before React re-renders.
 *
 * Counterpart: `AppShell`'s desktop tab row, and the density rules in
 * `theme/theme.ts`.
 */
import { useLayoutEffect, useRef, useState } from 'react'

/**
 * Ordered widest-first: the loop takes the first level that fits.
 *
 * The order of what gets spent is deliberate, cheapest first: PADDING (three
 * rungs of it), then type size, then the words themselves. A tab's padding is
 * slack — its text never reaches the edge — so it can go a long way before
 * anything a reader relies on is touched, and shrinking the type while that
 * slack is still there makes the row harder to read for no reason.
 *
 * Four of the five keep every label at full size or near it. Truncation is not
 * a rung at any point; see the note above.
 */
export const NAV_DENSITY_LEVELS = ['comfortable', 'snug', 'tight', 'condensed', 'icons'] as const

export type NavDensity = (typeof NAV_DENSITY_LEVELS)[number]

/** The last rung: nothing below this but the row's own horizontal scroll. */
export const TIGHTEST_NAV_DENSITY: NavDensity = 'icons'

/**
 * @param signature changes when the tabs themselves do, forcing a re-fit —
 *   a resize is not the only thing that changes what has to fit.
 */
export function useFittedNavDensity<T extends HTMLElement>(signature: string) {
  const ref = useRef<T | null>(null)
  const [density, setDensity] = useState<NavDensity>('comfortable')

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return

    const fit = () => {
      // Starts at the tightest so that "nothing fits" needs no special case:
      // past every level, the row falls back on its own `overflowX: auto`.
      let fitted: NavDensity = TIGHTEST_NAV_DENSITY
      // Each level is written to the DOM and measured there, rather than set
      // as state and measured a render later: the levels this loop tries must
      // never reach the screen, and reading `scrollWidth` forces the layout
      // that makes the reading true for the level just written.
      for (const level of NAV_DENSITY_LEVELS) {
        element.dataset.navDensity = level
        // +1 absorbs sub-pixel layout, which otherwise reports a row that fits
        // exactly as overflowing and drops a level for no visible reason.
        if (element.scrollWidth <= element.clientWidth + 1) {
          fitted = level
          break
        }
      }
      element.dataset.navDensity = fitted
      setDensity(fitted)
    }

    fit()

    // A label's width is not final at mount. A webfont arriving afterwards
    // re-measures every one of them, and the row can outgrow the level chosen
    // for it — while the row's own box, set by its parent, never changes. So
    // the observer below cannot see this happen and the row would sit
    // overflowing at a level that measured as fitting.
    let cancelled = false
    void document.fonts?.ready.then(() => {
      if (!cancelled) fit()
    })

    if (typeof ResizeObserver === 'undefined') return () => { cancelled = true }
    // The BORDER box, and deliberately not the observer's own `contentRect`.
    // Each level changes the row's padding, which changes its content box
    // without changing the space it was given — so a content-box comparison
    // treats our own write as new information and re-fits in response to
    // itself. The border box is set by the parent and only moves when the
    // space genuinely does.
    let lastWidth = element.offsetWidth
    const observer = new ResizeObserver(() => {
      const width = element.offsetWidth
      if (Math.abs(width - lastWidth) < 1) return
      lastWidth = width
      fit()
    })
    observer.observe(element)
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [signature])

  return { ref, density }
}
