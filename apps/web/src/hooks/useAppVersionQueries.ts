/**
 * The two build-identity queries the footer and the About dialog both read, owned once so they
 * share one cache entry each and cannot drift apart:
 * - the server's `GET /api/app/version` (product version, revision, update status);
 * - the installed native wrapper's own build, when running inside the Android or desktop app.
 */
import { useQuery } from '@tanstack/react-query'
import type { AppVersionResponse } from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { isNativeApp, nativeAppBuild } from '../native/bridge'

/** The server build answering this tab; refreshed at most every ten minutes. */
export function useServerAppVersion() {
  return useQuery({
    queryKey: ['app', 'version'],
    queryFn: ({ signal }) => apiFetch<AppVersionResponse>('/api/app/version', { signal }),
    retry: false,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false
  })
}

/** The installed Android or desktop app's build, or null in a browser or on an older app. */
export function useInstalledAppBuild() {
  return useQuery({
    queryKey: ['native-app', 'build'],
    queryFn: readInstalledAppBuild,
    enabled: isNativeApp(),
    retry: false,
    staleTime: Infinity
  })
}

async function readInstalledAppBuild() {
  try {
    return await nativeAppBuild()
  } catch {
    // This optional identity must not turn an otherwise supported older app into an operational error.
    return null
  }
}
