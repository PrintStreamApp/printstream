/**
 * GHCR update check for the published open-core image.
 *
 * Only the published open-core image (`getAppBuildInfo().published`) has a
 * registry update channel; for every other run this module is inert. When
 * active, it periodically asks the registry what git revision the `:latest`
 * tag was built from and compares it to the running image's revision, caching
 * the verdict. The check is best-effort: any network/registry failure degrades
 * to an `unknown` status and never throws into a request path.
 *
 * The request path (`getAppUpdateInfo`) is non-blocking — it returns the cached
 * verdict and kicks a background refresh when stale — so the footer endpoint
 * stays fast even on the first hit.
 */
import { type AppUpdateInfo, type AppUpdateStatusValue } from '@printstream/shared'
import { env } from './env.js'
import { getAppBuildInfo, shortenRevision } from './app-build-info.js'

const REGISTRY_HOST = 'ghcr.io'
const LATEST_TAG = 'latest'
const REQUEST_TIMEOUT_MS = 8_000
const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000
const FAILURE_TTL_MS = 15 * 60 * 1000

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json'
].join(', ')

const REVISION_LABEL = 'org.opencontainers.image.revision'

interface CheckSnapshot {
  status: AppUpdateStatusValue
  latestRevision: string | null
  /** ISO timestamp of the last *successful* registry read. */
  checkedAt: string | null
  error: string | null
  /** Wall-clock of the last attempt (success or failure), for TTL gating. */
  fetchedAtMs: number
}

let cache: CheckSnapshot | null = null
let inFlight: Promise<void> | null = null
let intervalTimer: ReturnType<typeof setInterval> | null = null

/** Image reference an operator pulls to update. */
export function getUpdateImageRef(): string {
  return `${REGISTRY_HOST}/${env.PRINTSTREAM_UPDATE_CHECK_IMAGE}:${LATEST_TAG}`
}

function isUpdateCheckEnabled(): boolean {
  return getAppBuildInfo().published && !env.PRINTSTREAM_DISABLE_UPDATE_CHECK
}

/** Pure comparison so the verdict logic stays testable without a network. */
export function compareRevisions(current: string | null, latest: string | null): AppUpdateStatusValue {
  if (!current || !latest) return 'unknown'
  return current === latest ? 'current' : 'updateAvailable'
}

async function fetchJson(url: string, token: string, accept: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: accept },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(`registry ${response.status} for ${url}`)
  }
  return await response.json()
}

/**
 * Walks the registry to read `:latest`'s embedded git revision label:
 * anonymous pull token -> manifest (index -> a linux platform child) -> image
 * config blob -> `org.opencontainers.image.revision`. Returns null when the
 * label is absent.
 */
export async function fetchLatestRevisionFromRegistry(repo: string): Promise<string | null> {
  const tokenUrl = `https://${REGISTRY_HOST}/token?service=${REGISTRY_HOST}&scope=repository:${repo}:pull`
  const tokenResponse = await fetch(tokenUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!tokenResponse.ok) throw new Error(`registry token ${tokenResponse.status}`)
  const token = (await tokenResponse.json() as { token?: unknown }).token
  if (typeof token !== 'string' || token.length === 0) throw new Error('registry token missing')

  const base = `https://${REGISTRY_HOST}/v2/${repo}`
  const topManifest = await fetchJson(`${base}/manifests/${LATEST_TAG}`, token, MANIFEST_ACCEPT) as ManifestDoc

  let imageManifest = topManifest
  if (Array.isArray(topManifest.manifests)) {
    const child = pickPlatformManifest(topManifest.manifests)
    if (!child) throw new Error('no platform manifest in index')
    imageManifest = await fetchJson(`${base}/manifests/${child.digest}`, token, MANIFEST_ACCEPT) as ManifestDoc
  }

  const configDigest = imageManifest.config?.digest
  if (typeof configDigest !== 'string') throw new Error('image config missing')
  const config = await fetchJson(`${base}/blobs/${configDigest}`, token, 'application/vnd.oci.image.config.v1+json') as ImageConfigDoc
  const revision = config.config?.Labels?.[REVISION_LABEL]
  return typeof revision === 'string' && revision.length > 0 ? revision : null
}

interface ManifestDoc {
  manifests?: Array<{ digest: string, platform?: { architecture?: string, os?: string } }>
  config?: { digest?: string }
}
interface ImageConfigDoc {
  config?: { Labels?: Record<string, string> }
}

function pickPlatformManifest(manifests: NonNullable<ManifestDoc['manifests']>) {
  return manifests.find((entry) =>
    entry.platform?.os === 'linux' &&
    entry.platform.architecture != null &&
    entry.platform.architecture !== 'unknown'
  ) ?? null
}

async function runCheck(currentRevision: string | null): Promise<void> {
  const now = Date.now()
  try {
    const latest = await fetchLatestRevisionFromRegistry(env.PRINTSTREAM_UPDATE_CHECK_IMAGE)
    cache = {
      status: compareRevisions(currentRevision, latest),
      latestRevision: latest,
      checkedAt: new Date(now).toISOString(),
      error: null,
      fetchedAtMs: now
    }
  } catch (error) {
    cache = {
      status: cache?.status ?? 'unknown',
      latestRevision: cache?.latestRevision ?? null,
      checkedAt: cache?.checkedAt ?? null,
      error: error instanceof Error ? error.message : 'update check failed',
      fetchedAtMs: now
    }
  }
}

function triggerRefreshIfStale(currentRevision: string | null): void {
  if (inFlight) return
  const ttl = cache?.error ? FAILURE_TTL_MS : SUCCESS_TTL_MS
  if (cache && Date.now() - cache.fetchedAtMs < ttl) return
  inFlight = runCheck(currentRevision).finally(() => {
    inFlight = null
  })
}

/**
 * Current update verdict for the footer. Returns null when this run has no
 * registry update channel (not the published image, or explicitly disabled).
 * Non-blocking: serves the cached verdict and refreshes in the background.
 */
export function getAppUpdateInfo(): AppUpdateInfo | null {
  if (!isUpdateCheckEnabled()) return null
  const build = getAppBuildInfo()
  triggerRefreshIfStale(build.revision)
  return {
    status: cache?.status ?? 'unknown',
    latestRevision: cache?.latestRevision ?? null,
    latestShortRevision: shortenRevision(cache?.latestRevision ?? null),
    checkedAt: cache?.checkedAt ?? null,
    imageRef: getUpdateImageRef()
  }
}

/** Warm the cache at startup and refresh periodically. No-op when ineligible. */
export function startAppUpdateChecks(): void {
  if (!isUpdateCheckEnabled() || intervalTimer) return
  triggerRefreshIfStale(getAppBuildInfo().revision)
  intervalTimer = setInterval(() => {
    triggerRefreshIfStale(getAppBuildInfo().revision)
  }, SUCCESS_TTL_MS)
  intervalTimer.unref?.()
}

/** Test seam: clear cached state between cases. */
export function resetAppUpdateCheckState(): void {
  cache = null
  inFlight = null
  if (intervalTimer) {
    clearInterval(intervalTimer)
    intervalTimer = null
  }
}
