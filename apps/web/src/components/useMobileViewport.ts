import { useMediaQueryMatch } from './useMediaQueryMatch'

/**
 * True at phone widths (<= 599px), for layout decisions. For behavior driven by
 * the on-screen keyboard or touch input, use `useTouchPointer` instead — a
 * narrow desktop window matches this but has no virtual keyboard.
 */
export function useMobileViewport(): boolean {
  return useMediaQueryMatch('(max-width: 599px)')
}
