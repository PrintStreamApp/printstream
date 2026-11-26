/**
 * Browser-only promotion state for the installed PrintStream clients.
 *
 * Visiting the sign-in screen raises a session flag, which survives an OAuth round trip. The app
 * shell retains it after authentication until the user acts on the matching released client offer.
 * Native wrappers never qualify.
 */
import { readStoredValue, removeStoredValue, writeStoredValue } from './browserStorageKeys'
import { nativeAppPromotionAfterSignInKey, nativeAppPromotionDevResetKey, nativeAppPromotionDismissedKeys } from './storageKeys'

export type NativeAppPromotionPlatform = 'android' | 'windows'

export interface NativeAppPromotion {
  platform: NativeAppPromotionPlatform
  platformLabel: string
  storeUrl: string
}


export interface NativeAppPlatformHints {
  userAgent?: string
  uaDataPlatform?: string
}


const PLATFORM_CONFIG: Record<NativeAppPromotionPlatform, NativeAppPromotion> = {
  android: {
    platform: 'android',
    platformLabel: 'Android',
    storeUrl: 'https://play.google.com/store/apps/details?id=app.printstream'
  },
  windows: {
    platform: 'windows',
    platformLabel: 'Windows',
    storeUrl: 'https://apps.microsoft.com/detail/9N2CJ8BB9RTZ'
  }
}

/** Remember that this tab displayed sign-in, including across an OAuth redirect. */
export function flagNativeAppPromotionAfterSignIn(): void {
  // Best-effort: storage-denied browsers skip optional promotion UI.
  writeStoredValue(nativeAppPromotionAfterSignInKey, '1')
}

/** Check whether sign-in requested an app offer without consuming it before the user acts. */
export function hasNativeAppPromotionAfterSignInFlag(): boolean {
  return readStoredValue(nativeAppPromotionAfterSignInKey) === '1'
}

/** Clear the post-sign-in request after the offer is dismissed or followed. */
export function clearNativeAppPromotionAfterSignInFlag(): void {
  removeStoredValue(nativeAppPromotionAfterSignInKey)
}

/** Resolve a released native client from low-entropy browser platform hints. */
export function resolveNativeAppPromotion(
  hints: NativeAppPlatformHints
): NativeAppPromotion | null {
  const platform = detectNativeAppPromotionPlatform(hints)
  if (!platform) return null

  return PLATFORM_CONFIG[platform]
}

/** Gather browser hints without exposing navigator parsing to the dialog. */
export function detectNativeAppPromotion(navigatorLike: Navigator = navigator): NativeAppPromotion | null {
  const uaData = (navigatorLike as Navigator & { userAgentData?: { platform?: string } }).userAgentData
  return resolveNativeAppPromotion({
    userAgent: navigatorLike.userAgent,
    uaDataPlatform: uaData?.platform
  })
}

export function isNativeAppPromotionDismissed(platform: NativeAppPromotionPlatform): boolean {
  return readStoredValue(nativeAppPromotionDismissedKeys.at(platform)) != null
}

/** Clear a stale dismissal once per dev tab without weakening real user dismissals. */
export function resetNativeAppPromotionDismissalForDevelopment(
  platform: NativeAppPromotionPlatform
): void {
  // Storage-denied browsers have no durable dismissal to reset; the helpers are best-effort.
  if (readStoredValue(nativeAppPromotionDevResetKey) === '1') return

  removeStoredValue(nativeAppPromotionDismissedKeys.at(platform))
  writeStoredValue(nativeAppPromotionDevResetKey, '1')
}

/** Suppress this platform's offer on this browser after either dialog action. */
export function dismissNativeAppPromotion(platform: NativeAppPromotionPlatform): void {
  // Best-effort: without durable storage the offer may return on a later sign-in.
  writeStoredValue(nativeAppPromotionDismissedKeys.at(platform), new Date().toISOString())
}

function detectNativeAppPromotionPlatform(
  hints: NativeAppPlatformHints
): NativeAppPromotionPlatform | null {
  const declaredPlatform = hints.uaDataPlatform?.toLowerCase() ?? ''
  const userAgent = hints.userAgent ?? ''

  // Android browsers can expose a generic Linux UA-CH platform while the traditional UA still
  // carries the reliable Android token. Prefer that strong signal before rejecting an explicitly
  // unsupported declared platform.
  if (/Android/i.test(userAgent)) return 'android'
  if (declaredPlatform === 'android') return 'android'
  if (declaredPlatform === 'windows') return 'windows'
  if (declaredPlatform) return null

  if (/Windows NT/i.test(userAgent)) return 'windows'
  return null
}
