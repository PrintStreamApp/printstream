/**
 * Retrieves the installed licence's mutable label for an explicit mobile
 * connection. No timer: Lifetime/community installs do not start polling.
 * Counterpart: the cloud's license-refresh /name route. Credentials stay on
 * the server; only the display label reaches the phone.
 */
import { mobileConnectionNameResponseSchema, type MobileConnectionNameResponse } from '@printstream/shared'
import { getInstalledLicenseKey } from './license-state.js'
import { getInstallationId } from './installation-id.js'
import { resolveLicenseRefreshOrigin } from './license-origin.js'

interface NameLookupDependencies {
  key: typeof getInstalledLicenseKey
  installationId: typeof getInstallationId
  origin: typeof resolveLicenseRefreshOrigin
  fetch: typeof fetch
  now: () => number
}

/**
 * Coalesce concurrent lookups and cap cloud contact to once per five minutes
 * per installed key. Failed lookups also cool down, but reject so the phone
 * retains its cached label. Single API process assumption, like licence refresh.
 */
export function createMobileConnectionNameReader(deps: NameLookupDependencies): () => Promise<MobileConnectionNameResponse> {
  let cached: { key: string; until: number; result: Promise<MobileConnectionNameResponse> } | undefined
  return async () => {
    const key = await deps.key()
    if (!key) {
      cached = undefined
      return { name: null }
    }
    if (cached?.key === key && cached.until > deps.now()) return cached.result

    async function lookup(): Promise<MobileConnectionNameResponse> {
      try {
        const response = await deps.fetch(`${deps.origin(key)}/api/license/refresh/name`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, installationId: await deps.installationId() }),
          redirect: 'error',
          signal: AbortSignal.timeout(5_000)
        })
        if (!response.ok) throw new Error('Lookup unavailable')
        return mobileConnectionNameResponseSchema.parse(await response.json())
      } catch {
        // Never forward transport/parser errors which could contain credentials
        // or an upstream response body into request logs or the browser.
        throw new Error('License display name lookup unavailable.')
      }
    }

    const result = lookup()
    cached = { key, until: deps.now() + 5 * 60_000, result }
    return result
  }
}

export const readMobileConnectionName = createMobileConnectionNameReader({
  key: getInstalledLicenseKey,
  installationId: getInstallationId,
  origin: resolveLicenseRefreshOrigin,
  fetch: (...args) => fetch(...args),
  now: Date.now
})
