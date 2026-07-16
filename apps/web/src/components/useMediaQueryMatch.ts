import { useEffect, useState } from 'react'

/**
 * True while `window.matchMedia(query)` matches. SSR-safe (false with no
 * `window`) and live-updating, including on legacy `addListener`-only browsers.
 * Prefer the named wrappers (`useMobileViewport`, `useTouchPointer`) over
 * calling this with an inline query so breakpoints stay centralized.
 */
export function useMediaQueryMatch(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') {
      return false
    }

    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined
    }

    const mediaQuery = window.matchMedia(query)
    const handleChange = (event?: MediaQueryListEvent) => {
      setMatches(event?.matches ?? mediaQuery.matches)
    }

    handleChange()

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange)
      return () => mediaQuery.removeEventListener('change', handleChange)
    }

    mediaQuery.addListener(handleChange)
    return () => mediaQuery.removeListener(handleChange)
  }, [query])

  return matches
}
