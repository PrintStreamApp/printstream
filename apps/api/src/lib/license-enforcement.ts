/**
 * Self-hosted license enforcement (core). Owns the question "may this install
 * add printers and start prints?" and nothing else, it never gates reading,
 * and never locks data away.
 *
 * **Who is enforced.** Every self-hosted build: the native (paid) app and the
 * Docker/OSS build alike. The latter is enforced because `LICENSE` (PolyForm
 * Noncommercial) already forbids the commercial use being gated, so requiring a
 * key states the existing terms rather than adding new ones. The multi-workspace
 * cloud licenses through subscriptions instead and is never enforced here.
 *
 * **What satisfies it** differs by build, and only here:
 * - Docker/OSS accepts a community *or* commercial key: non-commercial
 *   self-hosting is free, so a free community key clears the gate.
 * - The native app requires `commercial`; community keys cover Docker only.
 * In both, an *expired* key counts as no key (`readLicenseStatus` folds expiry
 * into `valid`), which is what makes a lapsed Pro subscription stop working.
 *
 * **Grace, not a wall.** An install with no sufficient key runs fully
 * functional for a window measured from first boot, then drops to `limited`:
 * printer adds and print dispatch are refused; everything already there keeps
 * working and stays visible. Docker/OSS gets the longer window because for
 * those installs the requirement is *new*, an existing deployment upgrading
 * into this must have time to fetch a free community key, not discover the
 * lock mid-print.
 *
 * Failures fail open throughout, a transient DB error must never brick a
 * paying customer's install. The one thing that must fail *closed* is an
 * expired key, and that is decided from the token itself, not from a query.
 *
 * Counterparts: `license-state.ts` (the installed key), `license-refresh.ts`
 * (keeps a subscription key alive), and the web's `LicenseSettingsSection` /
 * `LicenseBanner`, which render the mode this module reports.
 */
import type { LicenseEnforcement, LicenseStatus } from '@printstream/shared'
import { conflict } from './http-error.js'
import { isNativeDeployment, isSelfHostedDeployment } from './deployment-mode.js'
import { requestLicensedPrinters } from './license-entitlement-client.js'
import { getInstalledLicenseStatus } from './license-state.js'
import { printGuards } from './print-guards.js'
import { registerPrinterQuota } from './printer-quota.js'
import { rootPrisma } from './prisma.js'
import { scopeSettingKeyForWorkspace } from './workspace-settings.js'

/** Fresh native installs get this many days of full-featured evaluation. */
export const NATIVE_EVALUATION_DAYS = 14

/**
 * Docker/OSS installs get longer: unlike the native app this is not a trial of
 * something they bought, it is a newly-stated requirement on something already
 * running, and the key that satisfies it is free but has to be requested.
 */
export const SELF_HOSTED_GRACE_DAYS = 30

const FIRST_RUN_KEY = scopeSettingKeyForWorkspace(null, 'license.firstRunAt')
/**
 * The pre-1.0 key, written when enforcement was native-only. Read as a fallback
 * and adopted forward so a native install that has been running for months is
 * not handed a fresh evaluation window by the rename.
 */
const LEGACY_NATIVE_FIRST_RUN_KEY = scopeSettingKeyForWorkspace(null, 'license.nativeFirstRunAt')
const CACHE_TTL_MS = 60_000

export const NATIVE_LIMITED_MESSAGE =
  'The evaluation period has ended: enter a commercial license under Settings → License to continue. The native app requires a commercial license; community keys cover the Docker build only.'

export const SELF_HOSTED_LIMITED_MESSAGE =
  'This install needs a license to keep adding printers and starting prints. Add a free community key (personal, non-commercial use) or a commercial key under Settings → License.'

/** True when this build enforces a license at all. */
export function isLicenseEnforced(): boolean {
  return isSelfHostedDeployment()
}

/** The message shown when this build drops to `limited`. */
export function licenseLimitedMessage(): string {
  return isNativeDeployment() ? NATIVE_LIMITED_MESSAGE : SELF_HOSTED_LIMITED_MESSAGE
}

/**
 * Does this key clear the gate for this build? Native requires commercial;
 * Docker/OSS takes either edition. An expired key is already `valid: false`.
 */
export function licenseSatisfies(status: LicenseStatus, native: boolean): boolean {
  if (!status.valid) return false
  return native ? status.edition === 'commercial' : status.edition != null
}

/** Pure mode derivation, exported for tests. */
export function computeLicenseMode(input: {
  enforced: boolean
  native: boolean
  licensed: boolean
  firstRunAt: Date
  now: Date
}): { mode: LicenseEnforcement['mode']; graceEndsAt: Date | null } {
  if (!input.enforced || input.licensed) {
    return { mode: 'unrestricted', graceEndsAt: null }
  }
  const graceDays = input.native ? NATIVE_EVALUATION_DAYS : SELF_HOSTED_GRACE_DAYS
  const graceEndsAt = new Date(input.firstRunAt.getTime() + graceDays * 24 * 60 * 60 * 1000)
  return { mode: input.now < graceEndsAt ? 'evaluation' : 'limited', graceEndsAt }
}

/**
 * Read (or stamp on first read) when this install first booted into an
 * enforcing build. Adopts the legacy native-only key when present so the clock
 * is not silently restarted by the rename.
 *
 * Exported for tests, because this decides what happens to installs that ALREADY
 * EXIST when enforcement ships. Only reached when `isLicenseEnforced()` is true,
 * which was native-only before, so a Docker/OSS install carries no stamp and is
 * dated from the upgrade, giving it the full grace window rather than a window
 * that expired before it was ever told about.
 */
export async function getFirstRunAt(): Promise<Date> {
  const [current, legacy] = await Promise.all([
    rootPrisma.setting.findUnique({ where: { key: FIRST_RUN_KEY } }),
    rootPrisma.setting.findUnique({ where: { key: LEGACY_NATIVE_FIRST_RUN_KEY } })
  ])
  const existing = current ?? legacy
  if (existing) {
    const parsed = new Date(existing.value)
    if (!Number.isNaN(parsed.getTime())) {
      // Carry the legacy stamp forward once, preserving the original date.
      if (!current) {
        await rootPrisma.setting.upsert({
          where: { key: FIRST_RUN_KEY },
          create: { key: FIRST_RUN_KEY, value: existing.value },
          update: {}
        })
      }
      return parsed
    }
  }
  const now = new Date()
  await rootPrisma.setting.upsert({
    where: { key: FIRST_RUN_KEY },
    create: { key: FIRST_RUN_KEY, value: now.toISOString() },
    update: {}
  })
  return now
}

export async function getLicenseEnforcement(): Promise<LicenseEnforcement> {
  const native = isNativeDeployment()
  if (!isLicenseEnforced()) {
    return { enforced: false, native, mode: 'unrestricted', graceEndsAt: null }
  }
  try {
    const [status, firstRunAt] = await Promise.all([getInstalledLicenseStatus(), getFirstRunAt()])
    const { mode, graceEndsAt } = computeLicenseMode({
      enforced: true,
      native,
      licensed: licenseSatisfies(status, native),
      firstRunAt,
      now: new Date()
    })
    return { enforced: true, native, mode, graceEndsAt: graceEndsAt ? graceEndsAt.toISOString() : null }
  } catch (error) {
    // Fail open: a transient read failure must never lock a customer out.
    console.warn('[license] enforcement check failed; failing open', { error })
    return { enforced: true, native, mode: 'unrestricted', graceEndsAt: null }
  }
}

// --- Cached mode for the synchronous print-guard path ---

let cachedMode: LicenseEnforcement['mode'] = 'unrestricted'
let cacheFetchedAt = 0
let refreshInFlight: Promise<void> | null = null

function refreshCachedMode(): Promise<void> {
  refreshInFlight ??= getLicenseEnforcement()
    .then((enforcement) => {
      cachedMode = enforcement.mode
      cacheFetchedAt = Date.now()
    })
    .finally(() => {
      refreshInFlight = null
    })
  return refreshInFlight
}

/** Drop the cached mode after the installed license changes. */
export function invalidateLicenseCache(): void {
  cacheFetchedAt = 0
  void refreshCachedMode()
}

/** Reject printer creation while the install is past its evaluation window. */
export async function assertLicenseAllowsPrinterAdd(): Promise<void> {
  if (!isLicenseEnforced()) return
  const enforcement = await getLicenseEnforcement()
  if (enforcement.mode === 'limited') {
    throw conflict(licenseLimitedMessage())
  }
}

/**
 * Register the license print guard and printer allowance (called once at boot).
 *
 * The guard path is synchronous, so it reads the cached mode and refreshes it
 * in the background when stale, a just-expired evaluation takes effect within
 * a minute rather than blocking the dispatch hot path on a DB read.
 *
 * The printer allowance is counted **install-wide, not per workspace**: the
 * cap is a property of the key, and counting per workspace would let anyone lift
 * it by creating a second workspace. Registering here is safe because the cloud
 * billing module, the only other `registerPrinterQuota` caller, is absent
 * from exactly the builds this runs in.
 *
 * On a **metered** key (self-hosted Pro) the allowance is not a wall: adding a
 * printer past it buys the capacity inline and removing one credits it back, so
 * the install meters like a cloud workspace. Every other key keeps the old
 * behaviour, a fixed allowance and a refusal, because there is no
 * subscription behind it to grow.
 */
export function registerLicenseEnforcement(): void {
  if (!isLicenseEnforced()) return
  void refreshCachedMode()
  printGuards.register(() => {
    if (Date.now() - cacheFetchedAt > CACHE_TTL_MS) {
      void refreshCachedMode()
    }
    return cachedMode === 'limited'
      ? { allowed: false, reason: licenseLimitedMessage() }
      : { allowed: true }
  })
  registerPrinterQuota({
    getLimit: async () => (await getInstalledLicenseStatus()).maxPrinters,
    countPrinters: () => rootPrisma.printer.count(),
    // Buy the capacity rather than refusing, for a key that has a subscription
    // behind it. This is what makes a self-hosted install feel like a cloud
    // workspace: the operator adds a printer, the cloud bills the difference,
    // and the add goes through in the same request. Everything else, Lifetime,
    // community, a cancelled subscription, refuses with its own reason.
    raiseLimit: async (needed) => {
      // A fixed key (Lifetime, community) has no subscription to grow. Falling
      // through to `describeLimit` is right here: "upgrade your license" is the
      // operator's actual next step, where reporting that a metered change was
      // refused describes a mechanism they were never using.
      if (!(await getInstalledLicenseStatus()).metered) return null
      const result = await requestLicensedPrinters(needed)
      if (result.outcome === 'applied') invalidateLicenseCache()
      if (result.outcome === 'applied' || result.outcome === 'unchanged') return result.maxPrinters
      // The far end's reason is more useful than the generic cap message: it
      // names the actual obstacle (declined card, no subscription, key bound to
      // another install) and therefore where to go to fix it.
      throw conflict(result.message ?? licenseLimitedMessage())
    },
    describeLimit: (limit) =>
      `Your license covers ${limit} printer${limit === 1 ? '' : 's'}. Add printers to your plan, or upgrade your license, to connect more.`,
    // The other half of metering: removing a printer credits it back, so a
    // self-hosted fleet costs what it currently is rather than its high-water
    // mark. Idempotent on the total, so the fire after an ADD (where
    // `raiseLimit` already bought the capacity) is a no-op rather than a second
    // charge. Best-effort like every `onCountChanged`: a missed credit is a
    // billing correction, never a reason to fail the removal the operator asked
    // for.
    onCountChanged: async () => {
      // Nothing to meter on a community or Lifetime key, and this fires on every
      // printer add and remove, so the cheap local check comes before the count
      // and the request. `requestLicensedPrinters` refuses those keys anyway;
      // this just keeps the common case free.
      if (!(await getInstalledLicenseStatus()).metered) return
      const count = await rootPrisma.printer.count()
      const result = await requestLicensedPrinters(count)
      if (result.outcome === 'applied') invalidateLicenseCache()
    }
  })
}
