/**
 * Self-hosted license enforcement (core). Owns the question "may this install
 * add printers and start prints?" and nothing else — it never gates reading,
 * and never locks data away.
 *
 * **Who is enforced.** Every self-hosted build: the native (paid) app and the
 * Docker/OSS build alike. The latter is enforced because `LICENSE` (PolyForm
 * Noncommercial) already forbids the commercial use being gated, so requiring a
 * key states the existing terms rather than adding new ones. The multi-tenant
 * cloud licenses through subscriptions instead and is never enforced here.
 *
 * **What satisfies it** differs by build, and only here:
 * - Docker/OSS accepts a community *or* commercial key — non-commercial
 *   self-hosting is free, so a free community key clears the gate.
 * - The native app requires `commercial`; community keys cover Docker only.
 * In both, an *expired* key counts as no key (`readLicenseStatus` folds expiry
 * into `valid`), which is what makes a lapsed Pro subscription stop working.
 *
 * **Grace, not a wall.** An install with no sufficient key runs fully
 * functional for a window measured from first boot, then drops to `limited`:
 * printer adds and print dispatch are refused; everything already there keeps
 * working and stays visible. Docker/OSS gets the longer window because for
 * those installs the requirement is *new* — an existing deployment upgrading
 * into this must have time to fetch a free community key, not discover the
 * lock mid-print.
 *
 * Failures fail open throughout — a transient DB error must never brick a
 * paying customer's install. The one thing that must fail *closed* is an
 * expired key, and that is decided from the token itself, not from a query.
 *
 * Counterparts: `license-state.ts` (the installed key), `license-refresh.ts`
 * (keeps a subscription key alive), and the web's `LicenseSettingsSection` /
 * `LicenseBanner`, which render the mode this module reports.
 */
import type { LicenseEnforcement, LicenseStatus } from '@printstream/shared'
import { conflict } from './http-error.js'
import { isSelfHostedDeployment } from './deployment-mode.js'
import { env } from './env.js'
import { getInstalledLicenseStatus } from './license-state.js'
import { printGuards } from './print-guards.js'
import { registerPrinterQuota } from './printer-quota.js'
import { rootPrisma } from './prisma.js'
import { scopeSettingKeyForTenant } from './tenant-settings.js'

/** Fresh native installs get this many days of full-featured evaluation. */
export const NATIVE_EVALUATION_DAYS = 14

/**
 * Docker/OSS installs get longer: unlike the native app this is not a trial of
 * something they bought, it is a newly-stated requirement on something already
 * running, and the key that satisfies it is free but has to be requested.
 */
export const SELF_HOSTED_GRACE_DAYS = 30

const FIRST_RUN_KEY = scopeSettingKeyForTenant(null, 'license.firstRunAt')
/**
 * The pre-1.0 key, written when enforcement was native-only. Read as a fallback
 * and adopted forward so a native install that has been running for months is
 * not handed a fresh evaluation window by the rename.
 */
const LEGACY_NATIVE_FIRST_RUN_KEY = scopeSettingKeyForTenant(null, 'license.nativeFirstRunAt')
const CACHE_TTL_MS = 60_000

export const NATIVE_LIMITED_MESSAGE =
  'The evaluation period has ended — enter a commercial license under Settings → License to continue. The native app requires a commercial license; community keys cover the Docker build only.'

export const SELF_HOSTED_LIMITED_MESSAGE =
  'This install needs a license to keep adding printers and starting prints. Add a free community key (personal, non-commercial use) or a commercial key under Settings → License.'

/** True when this build enforces a license at all. */
export function isLicenseEnforced(): boolean {
  return env.PRINTSTREAM_NATIVE || isSelfHostedDeployment()
}

/** The message shown when this build drops to `limited`. */
export function licenseLimitedMessage(): string {
  return env.PRINTSTREAM_NATIVE ? NATIVE_LIMITED_MESSAGE : SELF_HOSTED_LIMITED_MESSAGE
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
 */
async function getFirstRunAt(): Promise<Date> {
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
  const native = env.PRINTSTREAM_NATIVE
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
 * in the background when stale — a just-expired evaluation takes effect within
 * a minute rather than blocking the dispatch hot path on a DB read.
 *
 * The printer allowance is counted **install-wide, not per workspace**: the
 * cap is a property of the key, and counting per tenant would let anyone lift
 * it by creating a second workspace. Registering here is safe because the cloud
 * billing module — the only other `registerPrinterQuota` caller — is absent
 * from exactly the builds this runs in.
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
    describeLimit: (limit) =>
      `Your license covers ${limit} printer${limit === 1 ? '' : 's'}. Add printers to your plan, or upgrade your license, to connect more.`
  })
}
