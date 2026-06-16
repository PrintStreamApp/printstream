/**
 * Browser-side env access. Centralizing this lets tests and SSR-style
 * contexts stub it without touching `import.meta.env` directly.
 */
export interface BrowserEnv {
  apiBaseUrl: string
  devMode: boolean
}

interface BrowserEnvInput {
  VITE_API_BASE_URL?: string
  DEV?: boolean | string
  MODE?: string
}

export function parseBrowserEnv(env: BrowserEnvInput): BrowserEnv {
  return {
    apiBaseUrl: env.VITE_API_BASE_URL ?? '',
    devMode: env.DEV === true || env.DEV === 'true' || env.MODE === 'development'
  }
}

export function getBrowserEnv(): BrowserEnv {
  const rawEnv = typeof import.meta !== 'undefined' && typeof import.meta.env === 'object' && import.meta.env
    ? import.meta.env
    : {}

  return parseBrowserEnv(rawEnv)
}
