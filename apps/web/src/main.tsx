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
import { App } from './App'
import { PromptDialogProvider } from './components/PromptDialogProvider'
import { getBrowserEnv } from './lib/browserEnv'
import { registerBuiltinPlugins } from './plugin/builtin'
import { registerAppServiceWorker } from './lib/appUpdate'
import { shouldSuppressGlobalErrorToast, shouldSuppressPassiveAuthQueryError } from './lib/queryErrorToast'
import { extractDisabledPluginNameFromErrorMessage } from './lib/pluginSettings'
import { completeSplashScreen, setSplashScreenProgress } from './lib/splashScreen'
import { toast } from './lib/toast'
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

setSplashScreenProgress(12, 'Starting app shell')
if (browserEnv.devMode) {
  void clearOldOriginState()
} else {
  registerAppServiceWorker()
}
const root = ReactDOM.createRoot(document.getElementById('root')!)

setSplashScreenProgress(34, 'Registering updates')
registerBuiltinPlugins()
setSplashScreenProgress(58, 'Loading built-in features')

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

setSplashScreenProgress(78, 'Preparing client state')
setSplashScreenProgress(90, 'Rendering interface')

root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <PromptDialogProvider>
          <App />
        </PromptDialogProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
)

completeSplashScreen()
