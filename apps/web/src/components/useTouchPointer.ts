import { useMediaQueryMatch } from './useMediaQueryMatch'

/**
 * True on touch-only devices (coarse primary pointer, no hover) — phones and
 * tablets, where focusing a text input summons an on-screen keyboard. False on
 * desktops and on touchscreen laptops whose primary pointer is a mouse/trackpad.
 * Use this (not `useMobileViewport`) for behavior that exists because of the
 * virtual keyboard: a narrow desktop window has no keyboard problem, and a
 * full-size tablet does.
 */
export function useTouchPointer(): boolean {
  return useMediaQueryMatch('(hover: none) and (pointer: coarse)')
}
