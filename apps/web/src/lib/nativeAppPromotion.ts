/**
 * Browser-only promotion state for the installed PrintStream clients.
 *
 * Visiting the sign-in screen raises a session flag, which survives an OAuth round trip. The app
 * shell consumes it after authentication and offers the matching released client once per browser
 * and platform. Native wrappers never qualify. Windows stays described here so certification is a
 * one-flag launch rather than a second implementation.
 */

export type NativeAppPromotionPlatform = 'android' | 'windows'

export interface NativeAppPromotion {
  platform: NativeAppPromotionPlatform
  platformLabel: string
  storeLabel: string
  storeUrl: string
}

interface NativeAppPromotionPlatformConfig extends NativeAppPromotion {
  released: boolean
}

export interface NativeAppPlatformHints {
  userAgent?: string
  uaDataPlatform?: string
}

const PROMPT_AFTER_SIGN_IN_KEY = 'printstream.nativeAppPromotion.afterSignIn.v1'
const DISMISSED_KEY_PREFIX = 'printstream.nativeAppPromotion.dismissed.v1.'

const PLATFORM_CONFIG: Record<NativeAppPromotionPlatform, NativeAppPromotionPlatformConfig> = {
  android: {
    platform: 'android',
    platformLabel: 'Android',
    storeLabel: 'Get it on Google Play',
    storeUrl: 'https://play.google.com/store/apps/details?id=app.printstream',
    released: true
  },
  windows: {
    platform: 'windows',
    platformLabel: 'Windows',
    storeLabel: 'Get it from Microsoft Store',
    storeUrl: 'https://apps.microsoft.com/detail/9N2CJ8BB9RTZ',
    // The listing exists, but it must not be promoted until Microsoft certifies the release.
    released: false
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

/** Consume the post-sign-in signal exactly once after authentication succeeds. */
export function takeNativeAppPromotionAfterSignInFlag(): boolean {
  try {
    const flagged = window.sessionStorage.getItem(PROMPT_AFTER_SIGN_IN_KEY) === '1'
    window.sessionStorage.removeItem(PROMPT_AFTER_SIGN_IN_KEY)
    return flagged
  } catch {
    return false
  }
}

/** Resolve a released native client from low-entropy browser platform hints. */
export function resolveNativeAppPromotion(
  hints: NativeAppPlatformHints
): NativeAppPromotion | null {
  const platform = detectNativeAppPromotionPlatform(hints)
  if (!platform) return null

  const config = PLATFORM_CONFIG[platform]
  if (!config.released) return null

  return {
    platform: config.platform,
    platformLabel: config.platformLabel,
    storeLabel: config.storeLabel,
    storeUrl: config.storeUrl
  }
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
