/**
 * Light marketing entry: the public landing/info pages rendered WITHOUT the app shell, the
 * plugin graph, or any workspace/query context. Lazily loaded by {@link Root} only on a cold
 * load of a marketing page (see `lib/marketingManifest`), so visiting the site never downloads
 * the app bundle.
 *
 * Supplies its own Joy theme + chrome CSS vars (App's `CssVarsProvider` lives inside App, which
 * this branch never mounts) and renders the private marketing module's routes + footer. The
 * open-source build ships no marketing module, so `Root` never mounts this.
 */
import { useEffect } from 'react'
import Box from '@mui/joy/Box'
import CssBaseline from '@mui/joy/CssBaseline'
import { CssVarsProvider } from '@mui/joy/styles'
import { Route, Routes } from 'react-router-dom'
import { PublicShell } from './components/PublicShell'
import { marketingModule } from './lib/privateModules'
import { dismissSplashScreenImmediately } from './lib/splashScreen'
import { buildChromeCssVars } from './theme/buildTheme'
import { defaultChrome, theme } from './theme/theme'

// Where the "enter app" CTAs point on a cold marketing load. Navigating here leaves the marketing
// fast-path, so `Root` mounts the full app, which then resolves real auth + workspace destination.
const APP_ENTRY = '/workspaces'

const chromeVars = buildChromeCssVars(defaultChrome)

export default function MarketingApp() {
  useEffect(() => {
    // Backstop: ensure the app-boot splash is gone for the marketing page (main.tsx already dismissed it
    // on a marketing cold load). Never run the app-boot progress/splash on a marketing page.
    dismissSplashScreenImmediately()
    if (typeof document === 'undefined') return
    for (const [key, value] of Object.entries(chromeVars)) {
      document.documentElement.style.setProperty(key, value)
    }
  }, [])

  const routes = marketingModule?.routes ?? []
  const context = { isAuthenticated: false, appHref: APP_ENTRY, accountHref: APP_ENTRY, demoLandingRoute: '' }

  return (
    <CssVarsProvider theme={theme} defaultMode="dark">
      <CssBaseline />
      <Box sx={chromeVars}>
        <PublicShell footer={marketingModule?.Footer ? <marketingModule.Footer /> : undefined}>
          <Routes>
            {routes.map((route) => (
              <Route key={route.path} path={route.path} element={route.render(context)} />
            ))}
            {/* Any non-marketing path (the one-render "enter app" transition): render nothing — Root's
                sticky enteredApp flag mounts the full app on the next render. Never redirect here. */}
            <Route path="*" element={null} />
          </Routes>
        </PublicShell>
      </Box>
    </CssVarsProvider>
  )
}
