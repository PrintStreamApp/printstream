/**
 * Native-build license enforcement (core). The native (paid) distribution
 * requires a commercial license; the Docker/OSS build does not enforce one
 * (community/commercial keys are an honor-system statement there).
 *
 * Policy, active only when `PRINTSTREAM_NATIVE` is set (the native server sets
 * it at boot):
 * - Valid commercial license → `unrestricted`.
 * - Otherwise (unlicensed OR community key — community covers Docker only):
 *   an evaluation window runs from first boot; during it the app is fully
 *   functional (`evaluation`), after it printer adds and print dispatch lock
 *   (`limited`) until a commercial key is entered. Existing printers stay
 *   visible and data is never locked away.
 *
 * The print-guard path is synchronous, so the current mode is kept in a small
 * cache refreshed in the background and invalidated whenever the installed
 * license changes. Failures fail open — a transient DB error must never brick
 * a paid customer's install.
 */
import type { NativeLicenseEnforcement } from '@printstream/shared'
import { conflict } from './http-error.js'
import { env } from './env.js'
import { getInstalledLicenseStatus } from './license-state.js'
import { printGuards } from './print-guards.js'
import { rootPrisma } from './prisma.js'
import { scopeSettingKeyForTenant } from './tenant-settings.js'

/** Fresh native installs get this many days of full-featured evaluation. */
export const NATIVE_EVALUATION_DAYS = 14

const FIRST_RUN_KEY = scopeSettingKeyForTenant(null, 'license.nativeFirstRunAt')
const CACHE_TTL_MS = 60_000

export const NATIVE_LIMITED_MESSAGE =
  'The evaluation period has ended — enter a commercial license under Settings → License to continue. The native app requires a commercial license; community keys cover the Docker build only.'

/** Pure mode derivation, exported for tests. */
export function computeNativeLicenseMode(input: {
  native: boolean
  commercialLicensed: boolean
  firstRunAt: Date
  now: Date
}): { mode: NativeLicenseEnforcement['mode']; graceEndsAt: Date | null } {
  if (!input.native || input.commercialLicensed) {
    return { mode: 'unrestricted', graceEndsAt: null }
  }
  const graceEndsAt = new Date(input.firstRunAt.getTime() + NATIVE_EVALUATION_DAYS * 24 * 60 * 60 * 1000)
  return { mode: input.now < graceEndsAt ? 'evaluation' : 'limited', graceEndsAt }
}

/** Read (or stamp on first read) when this native install first booted. */
async function getFirstRunAt(): Promise<Date> {
  const existing = await rootPrisma.setting.findUnique({ where: { key: FIRST_RUN_KEY } })
  if (existing) {
    const parsed = new Date(existing.value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  const now = new Date()
  await rootPrisma.setting.upsert({
    where: { key: FIRST_RUN_KEY },
    create: { key: FIRST_RUN_KEY, value: now.toISOString() },
    update: {}
  })
  return now
}

export async function getNativeLicenseEnforcement(): Promise<NativeLicenseEnforcement> {
  if (!env.PRINTSTREAM_NATIVE) {
    return { native: false, mode: 'unrestricted', graceEndsAt: null }
  }
  try {
    const [status, firstRunAt] = await Promise.all([getInstalledLicenseStatus(), getFirstRunAt()])
    const { mode, graceEndsAt } = computeNativeLicenseMode({
      native: true,
      commercialLicensed: status.valid && status.edition === 'commercial',
      firstRunAt,
      now: new Date()
    })
    return { native: true, mode, graceEndsAt: graceEndsAt ? graceEndsAt.toISOString() : null }
  } catch (error) {
    // Fail open: a transient read failure must never lock a customer out.
    console.warn('[license] native enforcement check failed; failing open', { error })
    return { native: true, mode: 'unrestricted', graceEndsAt: null }
  }
}

// --- Cached mode for the synchronous print-guard path ---

let cachedMode: NativeLicenseEnforcement['mode'] = 'unrestricted'
let cacheFetchedAt = 0
let refreshInFlight: Promise<void> | null = null

function refreshCachedMode(): Promise<void> {
  refreshInFlight ??= getNativeLicenseEnforcement()
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
export function invalidateNativeLicenseCache(): void {
  cacheFetchedAt = 0
  void refreshCachedMode()
}

/** Reject printer creation while the native install is past its evaluation. */
export async function assertNativeLicenseAllowsPrinterAdd(): Promise<void> {
  if (!env.PRINTSTREAM_NATIVE) return
  const enforcement = await getNativeLicenseEnforcement()
  if (enforcement.mode === 'limited') {
    throw conflict(NATIVE_LIMITED_MESSAGE)
  }
}

/**
 * Register the native-license print guard (called once at boot, native only).
 * The guard path is synchronous, so it reads the cached mode and refreshes it
 * in the background when stale — a just-expired evaluation takes effect within
 * a minute rather than blocking the dispatch hot path on a DB read.
 */
export function registerNativeLicensePrintGuard(): void {
  if (!env.PRINTSTREAM_NATIVE) return
  void refreshCachedMode()
  printGuards.register(() => {
    if (Date.now() - cacheFetchedAt > CACHE_TTL_MS) {
      void refreshCachedMode()
    }
    return cachedMode === 'limited'
      ? { allowed: false, reason: NATIVE_LIMITED_MESSAGE }
      : { allowed: true }
  })
}
