/**
 * The ONE Joy theme provider for every entry branch (`App`, `MarketingApp`,
 * `PublicToolApp`). It owns a single invariant: **this app renders dark, always.**
 *
 * PrintStream has no light mode. The user-selectable themes (Default/Aurora, the
 * flat family) are all dark palettes supplied under `colorSchemes.dark`, and no
 * light palette has ever been designed or tested. But Joy does not know that:
 * `extendTheme` merges its own stock LIGHT palette in regardless, and Joy's mode
 * is persisted per origin in `localStorage`, where the stored value OUTRANKS
 * `defaultMode`. So a single stray write of `"light"` puts the whole app on a
 * palette nobody has ever looked at — white surfaces, near-black text, and no UI
 * anywhere to undo it, permanently, on that browser.
 *
 * That is not hypothetical: a scratch page mounting a bare `<CssVarsProvider>`
 * (whose own default mode is `light`) on the dev origin wrote `joy-mode: "light"`,
 * and every later load of the real app inherited it. The marketing page's feature
 * cards — the one surface using a plain `Card variant="outlined"` rather than
 * hardcoded colours — rendered solid white.
 *
 * Two defences, because either alone leaves a hole:
 *
 * 1. **Namespaced storage keys.** Joy's defaults (`joy-mode`,
 *    `joy-color-scheme-*`) are shared by every Joy app on an origin, so anything
 *    else served from the same host and port can set ours. Our keys cannot be
 *    reached by a provider that does not name them.
 * 2. **Normalise on load.** The stored mode is forced back to `dark` before Joy
 *    reads it, so a value that somehow got written — by an older build, a devtools
 *    edit, a future `setMode` call — self-heals on the next page load instead of
 *    sticking forever.
 *
 * Enforced by `AppThemeProvider.test.ts`, which fails the build on a raw
 * `CssVarsProvider` in app code.
 *
 * Revisit if a light palette is ever actually designed: at that point the mode
 * becomes a real user preference and defence 2 has to go.
 */
import { CssVarsProvider } from '@mui/joy/styles'
import type { Theme } from '@mui/joy/styles'
import type { ReactNode } from 'react'

/**
 * Namespaced so a co-located Joy surface writing Joy's default `joy-mode` cannot
 * reach us. Changing these strings strands every browser's stored value on the old
 * key — harmless here (the only legal value is the one we force anyway), but it
 * would matter the moment the mode becomes a real preference.
 */
const MODE_STORAGE_KEY = 'printstream-color-mode'
const COLOR_SCHEME_STORAGE_KEY = 'printstream-color-scheme'

/** The only mode this app supports. */
const FORCED_MODE = 'dark'

/**
 * Overwrite any stored mode with `dark` before Joy reads it.
 *
 * Runs at module scope — i.e. at import time, ahead of the first render — because
 * Joy resolves the mode from storage while rendering. Best-effort by design:
 * storage can throw (Safari private mode, a blocked third-party context) and a
 * theme preference is never worth failing a page load over. If it does throw, the
 * namespaced key still holds, and the key has no legal value other than `dark`.
 */
function forceDarkMode(): void {
  if (typeof window === 'undefined') return
  try {
    if (window.localStorage.getItem(MODE_STORAGE_KEY) !== FORCED_MODE) {
      window.localStorage.setItem(MODE_STORAGE_KEY, FORCED_MODE)
    }
  } catch {
    // Storage unavailable; the namespaced key and defaultMode still resolve dark.
  }
}

forceDarkMode()

export function AppThemeProvider({ theme, children }: { theme: Theme; children: ReactNode }) {
  return (
    <CssVarsProvider
      theme={theme}
      defaultMode={FORCED_MODE}
      modeStorageKey={MODE_STORAGE_KEY}
      colorSchemeStorageKey={COLOR_SCHEME_STORAGE_KEY}
    >
      {children}
    </CssVarsProvider>
  )
}
