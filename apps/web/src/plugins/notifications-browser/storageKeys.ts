/**
 * Browser storage keys owned by the notifications-browser plugin (CONF-7, D-105; the registry is
 * `lib/browserStorageKeys.ts`).
 */
import { defineStorageKey } from '../../lib/browserStorageKeys'

/** The dismissed "turn on notifications" prompt on this device. */
export const enrollmentPromptDismissedKey = defineStorageKey({
  key: 'printstream.browserNotifications.enrollmentPromptDismissed',
  storage: 'local',
  kind: 'record',
  owner: 'plugin:notifications-browser',
  legacyKeys: ['bambu.notifications-browser.enrollment-prompt-dismissed.v1']
})
