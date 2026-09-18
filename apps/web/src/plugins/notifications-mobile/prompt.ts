/** Origin-local dismissal for an account's membership selection. No tokens or credentials are stored. */
const dismissedThisSession = new Set<string>()

/** Remember existing destinations separately so adding a membership cannot reselect an old opt-out. */
export function notificationScopeOfferKey(userId: string, scopeId: string): string {
  return `printstream.mobile-notifications.scope:${encodeURIComponent(userId)}:${encodeURIComponent(scopeId)}`
}

/** Storage-denied WebViews still suppress repeat offers until the app reloads. */
export function isMobileNotificationOfferDismissed(key: string): boolean {
  if (dismissedThisSession.has(key)) return true
  try {
    return window.localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

export function dismissMobileNotificationOffer(key: string): void {
  dismissedThisSession.add(key)
  try {
    window.localStorage.setItem(key, '1')
  } catch {
    // The in-memory fallback above also covers blocked browser storage.
  }
}
