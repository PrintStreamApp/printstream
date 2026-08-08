/**
 * Self-hosted entitlement client (core). Asks the vendor cloud to change how
 * many printers this install's license covers, and stores the re-signed key it
 * gets back.
 *
 * **Why this exists.** Without it a self-hosted operator has to decide their
 * fleet size at purchase time and go back to a billing page to change it, while
 * a cloud workspace just adds a printer and is metered. This closes that gap:
 * adding a printer past the covered count asks the cloud to raise the
 * entitlement, the cloud bills the difference, and the printer is allowed in the
 * same request — the same experience, with the money handled the same way.
 *
 * **The install asks; the cloud decides.** The count is not sent as a fact to be
 * trusted — `maxPrinters` only moves once Paddle has taken the money, and it
 * comes back signed. That ordering is what makes the whole scheme work on the
 * Docker/OSS build, where this file is open source and a self-reported number
 * would mean nothing.
 *
 * What it sends is still narrow, matching `license-refresh-client.ts`: the key,
 * this install's id, and one number the operator's own action just chose. No
 * telemetry, no printer details, and nothing at all unless the operator changes
 * their fleet.
 *
 * Failure posture: a refusal or a network error leaves the install exactly as it
 * was — the previous entitlement still applies, and the caller surfaces why. It
 * must never fail open (that would sell nothing) and never fail destructively
 * (a cloud outage must not shrink a running farm).
 *
 * Counterpart: `apps/api/src/private/cloud/license-entitlement.ts` (the endpoint).
 */
import { licenseEntitlementResponseSchema } from '@printstream/shared'
import { getInstallationId } from './installation-id.js'
import { resolveLicenseRefreshOrigin } from './license-origin.js'
import { getInstalledLicenseKey, getInstalledLicenseStatus, setInstalledLicenseKey } from './license-state.js'

export interface EntitlementChangeResult {
  outcome: 'applied' | 'unchanged' | 'refused' | 'failed'
  /** The allowance now in force, or null when it could not be established. */
  maxPrinters: number | null
  /** Operator-facing explanation for a refusal. Null when nothing went wrong. */
  message: string | null
}

const UNREACHABLE: EntitlementChangeResult = {
  outcome: 'failed',
  maxPrinters: null,
  message: 'Could not reach PrintStream to update your license. Check this install\'s internet access and try again.'
}

/**
 * Ask for `printers` to be covered, and install the re-signed key on success.
 *
 * `printers` is the TOTAL the install wants covered, never a delta: this call
 * charges a card, and a retry after a lost response must not charge twice.
 *
 * Returns `unchanged` when the subscription already covered that many — a
 * success, not a no-op to be retried.
 */
export async function requestLicensedPrinters(printers: number): Promise<EntitlementChangeResult> {
  const key = await getInstalledLicenseKey()
  if (!key) {
    return { outcome: 'refused', maxPrinters: null, message: 'This install has no license key to update.' }
  }
  const status = await getInstalledLicenseStatus()
  // Perpetual keys (Lifetime, community) have no subscription to meter, so this
  // would be a guaranteed refusal from the far end. Answered locally instead, so
  // an offline Lifetime install never makes the request at all.
  if (status.expiresAt == null) {
    return {
      outcome: 'refused',
      maxPrinters: status.maxPrinters,
      message: 'This license covers a fixed number of printers and cannot be changed from here.'
    }
  }

  try {
    const response = await fetch(new URL('/api/license/entitlement', resolveLicenseRefreshOrigin(key)), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, installationId: await getInstallationId(), printers }),
      signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) {
      console.warn('[license] entitlement request failed', { status: response.status })
      return UNREACHABLE
    }
    const parsed = licenseEntitlementResponseSchema.safeParse(await response.json())
    if (!parsed.success) {
      console.warn('[license] entitlement response did not match the expected shape')
      return UNREACHABLE
    }
    if (parsed.data.outcome === 'refused') {
      return { outcome: 'refused', maxPrinters: parsed.data.maxPrinters, message: parsed.data.message }
    }
    if (parsed.data.outcome === 'applied' && parsed.data.key) {
      // setInstalledLicenseKey verifies the signature, so a spoofed or
      // compromised host cannot widen this install's allowance.
      const stored = await setInstalledLicenseKey(parsed.data.key)
      if (!stored) {
        console.warn('[license] the entitlement response carried a key that failed verification; keeping the existing one')
        return UNREACHABLE
      }
      // The enforcement cache is NOT dropped here on purpose: doing so would
      // make this module import `license-enforcement.ts`, which registers the
      // quota hook that calls this one. Callers invalidate instead — see the
      // `applied` handling in `registerLicenseEnforcement` and the license route.
    }
    return { outcome: parsed.data.outcome, maxPrinters: parsed.data.maxPrinters, message: null }
  } catch (error) {
    console.warn('[license] entitlement request failed', { error })
    return UNREACHABLE
  }
}
