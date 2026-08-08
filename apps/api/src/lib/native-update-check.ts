/**
 * "Is there a newer native build?" — asked by the native single-file app.
 *
 * The Docker bundle has had an update notice since it shipped (`app-update-check.ts`,
 * which reads GHCR). The native bundle had nothing at all: no check, no notice,
 * no self-update. This closes that, notify-only; applying a build is Phase 2.
 *
 * **Anonymous by design.** The request carries no licence key, no installation
 * id, and no telemetry — it is a plain GET for a manifest. That matters twice
 * over: a perpetual key must make no unprompted request that identifies the
 * install (the promise `license-refresh-client.ts` keeps and the FAQ states),
 * and an owner whose updates window has LAPSED still has to be told a release
 * exists, because that notice is how they learn there is something to renew for.
 * The licence is checked when a build is downloaded, not when it is checked for
 * — see `private/cloud/server-release-channel.ts`.
 *
 * **Inert unless this is an identifiable native build.** A dev run, a Docker
 * run, or a native binary built locally without a baked fingerprint all report
 * null and make no request whatsoever.
 *
 * Best-effort throughout: any failure degrades to `unknown` and is retried
 * later. An update notice is never worth failing a request path over.
 *
 * Counterparts: `apps/server/src/server-build-info.ts` (what we are) and the
 * live server's `/api/server-runtime/releases` (what is current), served by
 * `apps/api/src/private/cloud/server-release-channel.ts`.
 */
import type { AppUpdateInfo } from '@printstream/shared'
import { env } from './env.js'
import { isNativeDeployment } from './deployment-mode.js'
import { shortenRevision } from './app-build-info.js'

/**
 * The live cloud origin, baked as a constant rather than exposed as a setting.
 * Internal plumbing most operators should never think about; surfacing it in an
 * env example or a settings screen would advertise a knob we do not want turned.
 * `NATIVE_UPDATE_ORIGIN` exists only to point tests at a fixture and is
 * deliberately absent from every `.env.example` and doc.
 */
const DEFAULT_ORIGIN = 'https://printstream.app'

const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000
const FAILURE_TTL_MS = 15 * 60 * 1000
const REQUEST_TIMEOUT_MS = 8_000

interface CacheEntry {
  info: AppUpdateInfo
  checkedAtMs: number
  error: boolean
}

let cache: CacheEntry | null = null
let inFlight: Promise<void> | null = null

/**
 * The identity this process was built with.
 *
 * Published as env by `apps/server/src/run.ts` before it imports the API, the
 * same way it hands over every other native-only setting — the bake belongs to
 * the native build, and the API only reads it. Empty or absent (any non-native
 * run, or a locally-built binary) means the check never fires.
 */
function installedFingerprint(): string | null {
  const value = env.PRINTSTREAM_SERVER_FINGERPRINT?.trim()
  return value ? value : null
}

/** Whether this process can meaningfully ask. */
function isActive(): boolean {
  return isNativeDeployment() && installedFingerprint() != null
}

/**
 * Non-blocking: returns the cached verdict and refreshes in the background when
 * stale, so the footer endpoint stays fast even on a cold cache.
 */
export function getNativeUpdateInfo(): AppUpdateInfo | null {
  if (!isActive()) return null
  const ttl = cache?.error ? FAILURE_TTL_MS : SUCCESS_TTL_MS
  if (!cache || Date.now() - cache.checkedAtMs > ttl) void refresh()
  return cache?.info ?? null
}

function refresh(): Promise<void> {
  inFlight ??= runCheck().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function runCheck(): Promise<void> {
  const origin = env.NATIVE_UPDATE_ORIGIN ?? DEFAULT_ORIGIN
  try {
    const response = await fetch(new URL('/api/server-runtime/releases', origin), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (!response.ok) throw new Error(`manifest request failed: ${response.status}`)
    const body = await response.json() as {
      current?: { fingerprint?: string; binaries?: Record<string, { url?: string }> } | null
    }
    const current = body.current?.fingerprint ?? null
    cache = {
      info: {
        status: current == null
          ? 'unknown'
          : current === installedFingerprint() ? 'current' : 'updateAvailable',
        latestRevision: current,
        latestShortRevision: shortenRevision(current),
        checkedAt: new Date().toISOString(),
        imageRef: null,
        downloadUrl: pickDownloadUrl(body.current?.binaries ?? null)
      },
      checkedAtMs: Date.now(),
      error: false
    }
  } catch (error) {
    console.warn('[native-update] could not check for a newer build; will retry', { error })
    cache = {
      info: {
        status: 'unknown',
        latestRevision: null,
        latestShortRevision: null,
        checkedAt: cache?.info.checkedAt ?? null,
        imageRef: null,
        downloadUrl: null
      },
      checkedAtMs: Date.now(),
      error: true
    }
  }
}

/**
 * The build for THIS machine, when the manifest offers one.
 *
 * Returns null rather than a wrong-platform URL: handing a Windows owner a Linux
 * binary is worse than telling them an update exists without a link.
 */
function pickDownloadUrl(binaries: Record<string, { url?: string }> | null): string | null {
  if (!binaries) return null
  const key = `${process.platform}-${process.arch}`
  const url = binaries[key]?.url
  return typeof url === 'string' ? url : null
}

/** Test seam: drop cached state between cases. */
export function resetNativeUpdateCheckForTests(): void {
  cache = null
  inFlight = null
}
