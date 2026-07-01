/**
 * App entry decision point. On a cold load of a public marketing page it mounts the light
 * {@link MarketingApp}; otherwise it mounts the full app. Both branches are `React.lazy`, and this
 * module imports only the leaf `marketingManifest` (no view / plugin / chart code), so the entry
 * chunk stays tiny — the heavy app shell + plugin graph download only when the app is actually entered.
 *
 * Sticky `enteredApp`: once any non-marketing path is visited, the full app stays mounted — App owns
 * its own in-session marketing routes, so e.g. an in-app logo click to "/" does NOT drop back to the
 * light marketing branch. The decision is therefore "cold-load only": the marketing fast-path applies
 * to the initial document load, and entering the app is a one-way transition.
 *
 * The open-source build has no marketing paths (`marketingRoutePaths` is empty), so this always
 * renders the app — identical to the pre-split behavior.
 */
import { Suspense, lazy, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { isMarketingPath, marketingRoutePaths } from './lib/marketingManifest'
import { showSplashScreen } from './lib/splashScreen'

const App = lazy(() => import('./App').then((module) => ({ default: module.App })))
const MarketingApp = lazy(() => import('./MarketingApp'))

/**
 * Suspense fallback for the app branch: re-show the boot splash while the heavy app chunk loads. This
 * is the loader the user expects "when going to the app" — both a cold load of an app route (where the
 * splash is already up) and entering the app from a marketing page (where it was dismissed). App.tsx
 * calls completeSplashScreen() once it's ready, hiding it again.
 */
function AppLoadingSplash() {
  useEffect(() => {
    showSplashScreen()
  }, [])
  return null
}

export function Root() {
  const location = useLocation()
  // Read the real initial URL synchronously (before any client navigation) for the cold-load decision.
  const startsInMarketing = marketingRoutePaths.length > 0 && isMarketingPath(window.location.pathname)
  const [enteredApp, setEnteredApp] = useState(!startsInMarketing)

  useEffect(() => {
    if (!isMarketingPath(location.pathname)) setEnteredApp(true)
  }, [location.pathname])

  // App branch: show the boot splash while its heavy chunk loads. Marketing branch: no splash (main.tsx
  // dismissed it for the cold load), so the tiny marketing chunk loads against the dark background.
  return (
    <Suspense fallback={enteredApp ? <AppLoadingSplash /> : null}>
      {enteredApp ? <App /> : <MarketingApp />}
    </Suspense>
  )
}
