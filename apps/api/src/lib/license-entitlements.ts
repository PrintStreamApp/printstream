/**
 * Entitlements that hang off the installed license but are NOT the right to run
 * (that lives in `license-enforcement.ts`). Today that means one thing: updates
 * and priority support, which the annual addon renews on a perpetual Lifetime
 * key and which a live Pro subscription includes for as long as it runs.
 *
 * The distinction matters and is easy to get wrong: a lapsed updates period
 * must never stop the app or lock data. The customer keeps the build they have,
 * forever — they simply stop receiving newer ones. Anything that reads this
 * helper should degrade to "you are on the build you own", never to an error.
 *
 * Fails **open**: an unreadable license, an unlicensed install, or a community
 * key (perpetual, `updatesUntil: null`) all count as entitled. Withholding
 * updates on a transient DB error would be a far worse failure than shipping a
 * build to someone whose addon expired an hour ago.
 */
import { getInstalledLicenseStatus } from './license-state.js'

/**
 * Whether this install is entitled to newer builds and priority support.
 *
 * @returns false only when a valid key is installed AND its updates window has
 * demonstrably passed.
 */
export async function areUpdatesEntitled(): Promise<boolean> {
  try {
    const status = await getInstalledLicenseStatus()
    if (!status.valid) return true
    return !status.updatesExpired
  } catch (error) {
    console.warn('[license] could not read the updates entitlement; allowing updates', { error })
    return true
  }
}

/**
 * Hook for the native in-place updater when it lands (today the native build
 * only notifies, it does not self-update). Call before applying a downloaded
 * build, not before checking for one: the *check* is what surfaces the renewal
 * prompt, and suppressing it would leave a lapsed customer with no signal at
 * all.
 *
 * @returns a reason string when the update must be refused, else null.
 */
export async function describeUpdateBlock(): Promise<string | null> {
  if (await areUpdatesEntitled()) return null
  return 'Updates and priority support for this license have ended. Renew to install newer releases; the build you have keeps running.'
}
