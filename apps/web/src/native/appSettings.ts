/** Origin-local requests for the native notification plugin's settings surface. No connection data crosses this seam. */
import { PrintStreamInstance } from './bridge'

const EVENT = 'printstream:notification-settings'
const CHANGED_EVENT = 'printstream:notification-settings-changed'
// Capture the native one-shot request before workspace/auth redirects replace the URL.
let pendingRequest = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('appNotifications') === '1'

export function takeAppNotificationSettingsRequest(): boolean {
  const requested = pendingRequest
  pendingRequest = false
  if (requested) {
    const url = new URL(window.location.href)
    url.searchParams.delete('appNotifications')
    window.history.replaceState(window.history.state, '', url)
  }
  return requested
}

export function hasAppNotificationSettingsRequest(): boolean {
  return pendingRequest
}

export function openAppNotificationSettings(): void {
  window.dispatchEvent(new window.Event(EVENT))
}

export function subscribeAppNotificationSettings(listener: () => void): () => void {
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}

/** Refresh origin-local status surfaces after a save, including a partially successful save. */
export function notificationSettingsChanged(): void {
  window.dispatchEvent(new window.Event(CHANGED_EVENT))
}

export function subscribeNotificationSettingsChanged(listener: () => void): () => void {
  window.addEventListener(CHANGED_EVENT, listener)
  return () => window.removeEventListener(CHANGED_EVENT, listener)
}

// Remember the caller separately from the one-shot open flag consumed by the consent form.
let returnToLocalSettings = pendingRequest

/** Successful save/cancel returns to the local screen that opened this server's consent form. */
export async function finishAppNotificationSettings(): Promise<void> {
  if (!returnToLocalSettings) return
  await PrintStreamInstance.menu({ view: 'settings' })
  returnToLocalSettings = false
}
