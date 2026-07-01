import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider
} from '@tanstack/react-query'
import { extractErrorMessage } from '@printstream/shared'
import { Root } from './Root'
import { PromptDialogProvider } from './components/PromptDialogProvider'
import { getBrowserEnv } from './lib/browserEnv'
import { registerAppServiceWorker } from './lib/appUpdate'
import { shouldSuppressGlobalErrorToast, shouldSuppressPassiveAuthQueryError } from './lib/queryErrorToast'
import { extractDisabledPluginNameFromErrorMessage } from './lib/pluginSettings'
import { isMarketingPath, marketingRoutePaths } from './lib/marketingManifest'
import { dismissSplashScreenImmediately, setSplashScreenProgress } from './lib/splashScreen'
import { toast } from './lib/toast'
// Self-hosted brand fonts (no Google Fonts CDN dependency). Weights mirror the
// theme: IBM Plex Sans 400/500/600 (body + UI), Space Grotesk 400/500/700 (display).
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/space-grotesk/400.css'
import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/700.css'
import './index.css'

const browserEnv = getBrowserEnv()

async function clearOldOriginState(): Promise<void> {
  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations()
    await Promise.allSettled(registrations.map((registration) => registration.unregister()))
  }

  if ('caches' in window) {
    const cacheKeys = await caches.keys()
    await Promise.allSettled(cacheKeys.map((cacheKey) => caches.delete(cacheKey)))
  }
}

// A cold load of a public marketing page must not show the app-boot splash ("Loading the app…"),
// so dismiss it immediately and skip the boot-progress text — Root renders the light marketing
// branch. Real app loads (and entering the app from marketing, see Root) keep/re-show the splash.
const marketingColdLoad = marketingRoutePaths.length > 0 && isMarketingPath(window.location.pathname)
const bootProgress = (percent: number, status: string): void => {
  if (!marketingColdLoad) setSplashScreenProgress(percent, status)
}
if (marketingColdLoad) dismissSplashScreenImmediately()

bootProgress(12, 'Starting app shell')
if (browserEnv.devMode) {
  void clearOldOriginState()
} else {
  registerAppServiceWorker()
}
const root = ReactDOM.createRoot(document.getElementById('root')!)

bootProgress(34, 'Registering updates')
// Built-in plugins register when the app shell chunk loads (see App.tsx), not here — so a cold
// load of a marketing page never pulls the plugin graph. Root lazy-loads the app branch.
bootProgress(58, 'Preparing')

// Surface any uncaught query/mutation errors as toast notifications so we
// have a single, consistent place users see failures. Individual call sites
// can opt out by handling `onError` themselves and swallowing it (or by
// catching directly when using `apiFetch` outside react-query).
const reportError = (error: unknown): void => {
  const message = extractErrorMessage(error, 'Something went wrong')
  if (extractDisabledPluginNameFromErrorMessage(message)) return
  toast.error(message)
}

const reportQueryError = (error: unknown, query: { meta?: unknown }): void => {
  if (shouldSuppressGlobalErrorToast(query.meta)) return
  if (shouldSuppressPassiveAuthQueryError(error)) return
  reportError(error)
}

const reportMutationError = (error: unknown, _variables: unknown, _context: unknown, mutation: { meta?: unknown }): void => {
  if (shouldSuppressGlobalErrorToast(mutation.meta)) return
  reportError(error)
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: false
    }
  },
  queryCache: new QueryCache({ onError: reportQueryError }),
  mutationCache: new MutationCache({ onError: reportMutationError })
})

bootProgress(78, 'Preparing client state')
bootProgress(90, 'Rendering interface')

root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <PromptDialogProvider>
          <Root />
        </PromptDialogProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
)
// The splash is completed by whichever branch mounts (App / MarketingApp) once it's ready, so it
// stays visible across the lazy chunk load instead of being dismissed before anything renders.
