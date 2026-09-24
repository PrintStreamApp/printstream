/**
 * Browser-only promotion state for the installed PrintStream clients.
 *
 * Visiting the sign-in screen raises a session flag, which survives an OAuth round trip. The app
 * shell retains it after authentication until the user acts on the matching released client offer.
 * Native wrappers never qualify.
 */

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

const PROMPT_AFTER_SIGN_IN_KEY = 'printstream.nativeAppPromotion.afterSignIn.v1'
const DISMISSED_KEY_PREFIX = 'printstream.nativeAppPromotion.dismissed.v1.'
const DEVELOPMENT_RESET_KEY = 'printstream.nativeAppPromotion.devReset.v1'

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
  try {
    window.sessionStorage.setItem(PROMPT_AFTER_SIGN_IN_KEY, '1')
  } catch {
    // Storage-denied browsers skip optional promotion UI.
  }
}

/** Check whether sign-in requested an app offer without consuming it before the user acts. */
export function hasNativeAppPromotionAfterSignInFlag(): boolean {
  try {
    return window.sessionStorage.getItem(PROMPT_AFTER_SIGN_IN_KEY) === '1'
  } catch {
    return false
  }
}

/** Clear the post-sign-in request after the offer is dismissed or followed. */
export function clearNativeAppPromotionAfterSignInFlag(): void {
  try {
    window.sessionStorage.removeItem(PROMPT_AFTER_SIGN_IN_KEY)
  } catch {
    // Storage-denied browsers have no retained signal to clear.
  }
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
  try {
    return window.localStorage.getItem(`${DISMISSED_KEY_PREFIX}${platform}`) != null
  } catch {
    return false
  }
}

/** Clear a stale dismissal once per dev tab without weakening real user dismissals. */
export function resetNativeAppPromotionDismissalForDevelopment(
  platform: NativeAppPromotionPlatform
): void {
  try {
    if (window.sessionStorage.getItem(DEVELOPMENT_RESET_KEY) === '1') return

    window.localStorage.removeItem(`${DISMISSED_KEY_PREFIX}${platform}`)
    window.sessionStorage.setItem(DEVELOPMENT_RESET_KEY, '1')
  } catch {
    // Storage-denied browsers have no durable dismissal to reset.
  }
}

/** Suppress this platform's offer on this browser after either dialog action. */
export function dismissNativeAppPromotion(platform: NativeAppPromotionPlatform): void {
  try {
    window.localStorage.setItem(`${DISMISSED_KEY_PREFIX}${platform}`, new Date().toISOString())
  } catch {
    // Without durable storage the offer may return on a later sign-in.
  }
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
