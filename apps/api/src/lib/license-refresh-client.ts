/**
 * Self-hosted license refresh client (core). Keeps a subscription-backed key
 * alive by asking the vendor cloud to re-sign it, on a timer.
 *
 * **This is the only thing a self-hosted install phones home for**, and it is
 * deliberately narrow: it sends the license key and nothing else — no printer
 * counts, no telemetry, no install identifier beyond the key's own id. Nothing
 * else in a self-hosted deployment contacts us.
 *
 * **The daily timer only ever runs for a subscription key.** A perpetual key
 * (Lifetime or community) is skipped, so a free non-commercial install and an
 * offline air-gapped Lifetime install never make a single unprompted outbound
 * request. That is a promise the marketing FAQ makes in as many words; do not
 * widen the timer without changing that copy too.
 *
 * A Lifetime key is not inert, though: renewing the annual updates addon
 * re-signs it, and the extension is a SIGNED field the install cannot learn any
 * other way. So a **user-initiated** refresh (`userInitiated`, the Settings
 * button) is allowed to fetch one. The distinction is consent, not capability —
 * someone pressing "Refresh license" has asked us to be contacted; a background
 * timer has not been asked anything. A community key is genuinely inert and is
 * skipped either way.
 *
 * Failure posture: every error is swallowed and retried on the next tick. A
 * refresh that cannot reach us must never disturb the install; that is what the
 * key's multi-week window is for. The window, not the network, is the authority
 * on when access ends.
 *
 * Counterpart: `apps/api/src/private/cloud/license-refresh.ts` (the endpoint).
 */
import { licenseRefreshResponseSchema } from '@printstream/shared'
import { getInstallationId } from './installation-id.js'
import { isLicenseEnforced, invalidateLicenseCache } from './license-enforcement.js'
import { resolveLicenseRefreshOrigin } from './license-origin.js'
import { getInstalledLicenseKey, getInstalledLicenseStatus, setInstalledLicenseKey } from './license-state.js'

/**
 * How often to attempt a refresh. Daily: the key's window is measured in weeks,
 * so this only needs to be frequent enough that a transient outage has many
 * chances to recover before it matters.
 */
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Wait this long after boot before the first attempt, so startup stays quiet. */
const INITIAL_DELAY_MS = 60_000

let timer: NodeJS.Timeout | null = null

/**
 * Whether this key is worth a request to the vendor. Exported for tests: it is
 * the whole privacy contract in one predicate, so it should be hard to change
 * by accident.
 *
 * - Subscription key (`expiresAt` set): always — its run window is what the
 *   refresh exists to push forward.
 * - Lifetime key (perpetual, but with an updates window): only when a person
 *   asked, because its window changes rarely and never on its own.
 * - Community key, or no key at all: never. Nothing about it can change.
 */
export function shouldContactVendor(
  status: { expiresAt: number | null; updatesUntil: number | null; edition: string | null; valid: boolean },
  userInitiated: boolean
): boolean {
  if (!status.valid) return false
  if (status.expiresAt != null) return true
  return userInitiated && status.edition === 'commercial' && status.updatesUntil != null
}

/**
 * Run one refresh attempt.
 *
 * @returns what happened, for the settings surface and tests. Never throws:
 * callers on a timer have nothing useful to do with a network error.
 */
export async function refreshInstalledLicense(
  options: {
    /**
     * Set only when a person pressed the button. Lets a Lifetime key collect a
     * renewed updates window; the background timer must never pass this.
     */
    userInitiated?: boolean
  } = {}
): Promise<'skipped' | 'unchanged' | 'renewed' | 'revoked' | 'failed'> {
  const key = await getInstalledLicenseKey()
  if (!key) return 'skipped'
  const status = await getInstalledLicenseStatus()
  if (!shouldContactVendor(status, options.userInitiated === true)) return 'skipped'

  try {
    const response = await fetch(new URL('/api/license/refresh', resolveLicenseRefreshOrigin(key)), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, installationId: await getInstallationId() }),
      signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) {
      console.warn('[license] refresh request failed', { status: response.status })
      return 'failed'
    }
    const parsed = licenseRefreshResponseSchema.safeParse(await response.json())
    if (!parsed.success) {
      console.warn('[license] refresh response did not match the expected shape')
      return 'failed'
    }
    if (parsed.data.outcome === 'renewed' && parsed.data.key) {
      // setInstalledLicenseKey verifies the signature, so a compromised or
      // spoofed refresh host cannot install a key we would honour.
      const stored = await setInstalledLicenseKey(parsed.data.key)
      if (!stored) {
        console.warn('[license] refresh returned a key that failed verification; keeping the existing one')
        return 'failed'
      }
      invalidateLicenseCache()
      return 'renewed'
    }
    if (parsed.data.outcome === 'revoked') {
      // Leave the key in place: it is still valid until its window elapses, and
      // removing it would end access immediately — the opposite of the intent.
      console.warn('[license] the vendor reports this license is no longer active', { message: parsed.data.message })
      return 'revoked'
    }
    return 'unchanged'
  } catch (error) {
    console.warn('[license] refresh attempt failed; will retry', { error })
    return 'failed'
  }
}

/**
 * Start the refresh timer (called once at boot). No-op on builds that do not
 * enforce a license — the cloud has no installed key to refresh.
 */
export function startLicenseRefreshScheduler(): void {
  if (!isLicenseEnforced() || timer) return
  const tick = () => {
    void refreshInstalledLicense()
  }
  // `unref` so a pending timer never holds the process open during shutdown.
  setTimeout(tick, INITIAL_DELAY_MS).unref()
  timer = setInterval(tick, REFRESH_INTERVAL_MS)
  timer.unref()
}

export function stopLicenseRefreshScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
}
