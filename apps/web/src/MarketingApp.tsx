/**
 * Light marketing entry: the public landing/info pages rendered WITHOUT the app shell, the
 * plugin graph, or any workspace/query context. Lazily loaded by {@link Root} only on a cold
 * load of a marketing page (see `lib/marketingManifest`), so visiting the site never downloads
 * the app bundle.
 *
 * Supplies its own Joy theme + chrome CSS vars (App's own `AppThemeProvider` lives inside App, which
 * this branch never mounts) and renders the private marketing module's routes + footer. The
 * open-source build ships no marketing module, so `Root` never mounts this.
 *
 * It DOES resolve auth, despite being the light branch. Marketing CTAs swap on sign-in state
 * ("Login" becomes "Open app"), and this branch used to assert signed-OUT outright -- so a
 * signed-in reader landing on /pricing was told to log in, and saw it correct itself only if
 * something later mounted the full app. One small JSON call is the price of not lying about it;
 * until it settles, `authPending` keeps the CTAs on a neutral state rather than either answer.
 */
import { useEffect } from 'react'
import Box from '@mui/joy/Box'
import CssBaseline from '@mui/joy/CssBaseline'
import { AppThemeProvider } from './theme/AppThemeProvider'
import { Route, Routes } from 'react-router-dom'
import { PublicShell } from './components/PublicShell'
import { ScrollReset } from './components/ScrollReset'
import { useAuthBootstrapQuery } from './lib/authQuery'
import { marketingModule } from './lib/privateModules'
import { dismissSplashScreenImmediately } from './lib/splashScreen'
import { buildChromeCssVars } from './theme/buildTheme'
import { defaultChrome, theme } from './theme/theme'
import { customerApiBase } from './lib/customerRoutes'

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
  const authBootstrapQuery = useAuthBootstrapQuery({ suppressGlobalErrorToast: true })
  const actorType = authBootstrapQuery.data?.actor?.type ?? 'anonymous'
  const context = {
    isAuthenticated: actorType !== 'anonymous',
    authPending: authBootstrapQuery.isPending,
    appHref: APP_ENTRY,
    accountHref: APP_ENTRY,
    // No account here means no billing scope to route a purchase at; the CTA
    // falls back to its workspace-scoped path, as it did before.
    customerBasePath: authBootstrapQuery.data?.customers?.[0]
      ? customerApiBase(authBootstrapQuery.data.customers[0].id)
      : null,
    demoLandingRoute: ''
  }

  return (
    <AppThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={chromeVars}>
        <PublicShell footer={marketingModule?.Footer ? <marketingModule.Footer /> : undefined}>
          <ScrollReset />
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
    </AppThemeProvider>
  )
}
