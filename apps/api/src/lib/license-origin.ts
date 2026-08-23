/**
 * Where THIS install talks to about its licence.
 *
 * Owns one decision, shared by every outbound licensing call
 * (`license-refresh-client.ts`, `license-entitlement-client.ts`): given the
 * installed key, which deployment issued it and should therefore be asked to
 * re-sign it.
 *
 * **The key decides, not the config.** A signed `refreshOrigin` cannot drift
 * from the truth, whereas `LICENSE_REFRESH_ORIGIN` is a local setting that can
 * be wrong, and wrong in the worst possible way, because a refresh sent to the
 * wrong deployment fails silently and only surfaces weeks later when the run
 * window lapses, looking like an expired key rather than a misconfiguration.
 *
 * The override still wins when explicitly set, because an operator behind a
 * rewriting proxy or a private mirror has no other lever, and a licensing system
 * that cannot be pointed anywhere is a support problem of its own. A
 * disagreement is logged once rather than resolved silently: the two answers
 * differing is exactly the state that produces the confusing failure above.
 *
 * **Not a trust boundary.** `refreshOrigin` is readable only after the signature
 * has been verified against the embedded vendor key, so it selects where to
 * talk, never whether to believe. A build trusts exactly one signer, and no
 * value here can change that.
 */
import { verifyLicenseToken } from './license.js'
import { env } from './env.js'
import { getInstalledLicenseKey } from './license-state.js'

/**
 * Where keys issued before `refreshOrigin` existed have always refreshed.
 *
 * Also the answer for a key whose issuer did not know its own public URL. It is
 * a constant rather than an env default so that "the operator set this" stays
 * distinguishable from "nobody set this": the whole precedence rule below
 * depends on telling those apart.
 */
export const DEFAULT_LICENSE_ORIGIN = 'https://printstream.app'

let warnedAboutDisagreement = false

/**
 * The origin to send this key's refresh/entitlement requests to.
 *
 * Falls back to the vendor cloud for an absent, malformed, or mis-signed key:
 * callers reach this before deciding a request is worth making, and returning
 * something unusable would turn a licensing question into a crash.
 */
export function resolveLicenseRefreshOrigin(key: string | null | undefined, publicKeyPem?: string): string {
  const signed = signedRefreshOrigin(key, publicKeyPem)
  const configured = env.LICENSE_REFRESH_ORIGIN
  if (!configured) return signed ?? DEFAULT_LICENSE_ORIGIN

  // Latched: this runs on a daily timer, and a permanent misconfiguration
  // should not fill the log buffer with the same line forever.
  if (signed && signed !== configured && !warnedAboutDisagreement) {
    warnedAboutDisagreement = true
    console.warn(
      '[license] LICENSE_REFRESH_ORIGIN overrides the deployment this key was issued by; unset it unless that is deliberate',
      { configured, issuedBy: signed }
    )
  }
  return configured
}

/**
 * The verified key's own origin, or null when it does not name one.
 *
 * `publicKeyPem` follows `verifyLicenseToken`'s convention, it exists so tests
 * can drive this from a throwaway keypair, since core carries no signer and
 * cannot mint a token the embedded vendor key would accept.
 */
function signedRefreshOrigin(key: string | null | undefined, publicKeyPem?: string): string | null {
  if (!key) return null
  const payload = publicKeyPem ? verifyLicenseToken(key.trim(), publicKeyPem) : verifyLicenseToken(key.trim())
  if (!payload?.refreshOrigin) return null
  try {
    return new URL(payload.refreshOrigin).origin
  } catch {
    return null
  }
}

/** Exported for tests: forget that the disagreement warning was already logged. */
export function resetLicenseOriginWarningForTests(): void {
  warnedAboutDisagreement = false
}

/**
 * The deployment THIS install belongs to, resolved from its installed key.
 *
 * The same answer as {@link resolveLicenseRefreshOrigin}, with the key looked up
 * rather than passed, for callers outside the licensing flow that need to reach
 * their own cloud (the native app fetching its slicer runtime, say) and would
 * otherwise invent a second "which deployment" setting. There is one such
 * question and it has one answer; a build that refreshes its licence against
 * staging must not fetch its downloads from production.
 *
 * Requires the database, so call it after boot rather than while assembling
 * environment. Falls back to the vendor cloud on any failure, matching the
 * resolver's own posture: an unlicensed or not-yet-licensed install still has to
 * be able to reach somewhere.
 */
export async function resolveInstalledCloudOrigin(): Promise<string> {
  try {
    return resolveLicenseRefreshOrigin(await getInstalledLicenseKey())
  } catch {
    return DEFAULT_LICENSE_ORIGIN
  }
}
