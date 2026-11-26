import { readStoredValue, writeStoredValue, type StorageKeyRef } from '../../lib/browserStorageKeys'
import { mobileNotificationOfferKeys } from '../../lib/storageKeys'
import { mobileNotificationScopeOfferKeys } from './storageKeys'

/** Origin-local dismissal for an account's membership selection. No tokens or credentials are stored. */
const dismissedThisSession = new Set<string>()

/** Remember existing destinations separately so adding a membership cannot reselect an old opt-out. */
export function notificationScopeOfferKey(userId: string, scopeId: string): string {
  return mobileNotificationScopeOfferKeys.keyFor(`${encodeURIComponent(userId)}:${encodeURIComponent(scopeId)}`)
}

/**
 * The declared key behind an offer key, so its former name is read too. Offer keys travel as
 * strings because the offer hook compares them across renders.
 */
function offerStorageKey(key: string): StorageKeyRef {
  for (const family of [mobileNotificationOfferKeys, mobileNotificationScopeOfferKeys]) {
    const prefix = `${family.prefix}${family.separator}`
    if (key.startsWith(prefix)) return family.at(key.slice(prefix.length))
  }
  return { key, storage: 'local', legacyKeys: [], retiredKeys: [] }
}

/** Storage-denied WebViews still suppress repeat offers until the app reloads. */
export function isMobileNotificationOfferDismissed(key: string): boolean {
  if (dismissedThisSession.has(key)) return true
  return readStoredValue(offerStorageKey(key)) === '1'
}

export function dismissMobileNotificationOffer(key: string): void {
  dismissedThisSession.add(key)
  // Best-effort: the in-memory fallback above also covers blocked browser storage.
  writeStoredValue(offerStorageKey(key), '1')
}
