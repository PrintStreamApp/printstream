/**
 * Browser storage keys owned by the notifications-mobile plugin (CONF-7, D-105; the registry is
 * `lib/browserStorageKeys.ts`). The per-scope-set offer key it also reads is core's
 * (`mobileNotificationOfferKeys`), because core builds it.
 */
import { defineStorageKeyFamily } from '../../lib/browserStorageKeys'

/** A dismissed notification offer for one scope, keyed `<account>:<scope>`. */
export const mobileNotificationScopeOfferKeys = defineStorageKeyFamily({
  prefix: 'printstream.mobileNotifications.scope',
  separator: ':',
  storage: 'local',
  kind: 'record',
  owner: 'plugin:notifications-mobile',
  legacyPrefixes: ['printstream.mobile-notifications.scope']
})
