/** Platform-specific app destination shown when model-site browsing is unavailable in this host. */

export interface NativeModelBrowserAppRecommendation {
  platformLabel: string
  storeLabel: string | null
  storeUrl: string | null
}

export interface NativeModelBrowserPlatformHints {
  userAgent?: string
  uaDataPlatform?: string
}

/** Resolve the current browser platform without claiming unpublished desktop downloads exist. */
export function resolveNativeModelBrowserApp(
  hints: NativeModelBrowserPlatformHints
): NativeModelBrowserAppRecommendation {
  const declared = hints.uaDataPlatform?.toLowerCase() ?? ''
  const userAgent = hints.userAgent ?? ''

  if (/Android/i.test(userAgent) || declared === 'android') {
    return {
      platformLabel: 'Android',
      storeLabel: 'Get it on Google Play',
      storeUrl: 'https://play.google.com/store/apps/details?id=app.printstream'
    }
  }
  if (declared === 'windows' || /Windows NT/i.test(userAgent)) {
    // The existing Store listing is not yet the Electron release that owns
    // provider browsing. Do not send users to an older client and imply that
    // it can complete this flow.
    return { platformLabel: 'Windows', storeLabel: null, storeUrl: null }
  }
  if (declared === 'macos' || /Macintosh|Mac OS X/i.test(userAgent)) {
    return { platformLabel: 'macOS', storeLabel: null, storeUrl: null }
  }
  if (declared === 'linux' || /Linux/i.test(userAgent)) {
    return { platformLabel: 'Linux', storeLabel: null, storeUrl: null }
  }
  return { platformLabel: 'your platform', storeLabel: null, storeUrl: null }
}

/** Read low-entropy platform hints for the import-source dialog. */
export function detectNativeModelBrowserApp(
  navigatorLike: Navigator = navigator
): NativeModelBrowserAppRecommendation {
  const uaData = (navigatorLike as Navigator & { userAgentData?: { platform?: string } }).userAgentData
  return resolveNativeModelBrowserApp({
    userAgent: navigatorLike.userAgent,
    uaDataPlatform: uaData?.platform
  })
}
