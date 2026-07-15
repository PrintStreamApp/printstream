/**
 * Push-subscription lifecycle for the browser-notifications plugin.
 *
 * A browser holds exactly ONE `PushSubscription` per origin, while the
 * server registers that subscription's endpoint per workspace (and for the
 * platform workspace). Enabling notifications in a workspace therefore
 * REUSES the device's existing subscription and only registers its endpoint
 * with the current scope; disabling unregisters from the current scope and
 * leaves the browser subscription alive for the other workspaces. The only
 * time the subscription is recreated is when the server's VAPID key no
 * longer matches the one the subscription was created with (server
 * reinstall/migration) — at that point every scope's stored entry is
 * already undeliverable.
 *
 * Per-device permission state is intrinsic to the browser; the per-workspace
 * enabled state lives server-side and is read via the scope-aware
 * `subscriptions/lookup` endpoint — never shadowed in localStorage.
 */
import { apiFetch } from '../../lib/apiClient'

export const BROWSER_NOTIFICATIONS_PLUGIN_PATH = '/api/plugins/notifications-browser'

interface PluginInfo {
  publicKey: string
  subscriptions: number
}

export interface BrowserNotificationsSupportState {
  /**
   * Whether the page is running in a secure context (HTTPS, or a
   * `localhost` origin). Browsers gate Service Workers and the Push API
   * on this, so over plain HTTP `serviceWorker`/`pushManager` below are
   * also absent — we track it separately to explain *why* rather than
   * blaming the browser.
   */
  secureContext: boolean
  notification: boolean
  serviceWorker: boolean
  pushManager: boolean
}

/** Where this device stands relative to the CURRENT workspace scope. */
export interface BrowserNotificationsScopeState {
  /** The browser holds a push subscription for this origin. */
  deviceSubscribed: boolean
  /** That subscription's endpoint is registered in the current workspace. */
  registeredInWorkspace: boolean
}

export function detectBrowserNotificationsSupport(): BrowserNotificationsSupportState {
  if (typeof window === 'undefined') {
    return { secureContext: false, notification: false, serviceWorker: false, pushManager: false }
  }
  return {
    secureContext: window.isSecureContext === true,
    notification: 'Notification' in window,
    serviceWorker: 'serviceWorker' in navigator,
    pushManager: 'PushManager' in window
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const output = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i += 1) {
    output[i] = rawData.charCodeAt(i)
  }
  return output
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  // `ready` resolves once the active SW is controlling the page; if
  // the user just opened a fresh tab the registration may not exist
  // yet, so fall back to `getRegistration`.
  try {
    return await navigator.serviceWorker.ready
  } catch {
    return (await navigator.serviceWorker.getRegistration()) ?? null
  }
}

async function getCurrentSubscription(): Promise<PushSubscription | null> {
  const registration = await getRegistration()
  if (!registration) return null
  return registration.pushManager.getSubscription()
}

/** Whether a subscription was created against the server's current VAPID key. */
function subscriptionMatchesServerKey(subscription: PushSubscription, serverPublicKey: string): boolean {
  const applied = subscription.options.applicationServerKey
  if (!applied) return false
  const expected = urlBase64ToUint8Array(serverPublicKey)
  const actual = new Uint8Array(applied)
  if (actual.length !== expected.length) return false
  return expected.every((byte, index) => actual[index] === byte)
}

/**
 * Resolve this device's state for the current workspace. The lookup goes to
 * the server because per-workspace registration is server-side state; a
 * lookup failure surfaces as an error so callers can distinguish "not
 * registered" from "could not tell".
 */
export async function getBrowserNotificationsScopeState(): Promise<BrowserNotificationsScopeState> {
  const subscription = await getCurrentSubscription()
  if (!subscription) {
    return { deviceSubscribed: false, registeredInWorkspace: false }
  }
  const result = await apiFetch<{ registered: boolean }>(`${BROWSER_NOTIFICATIONS_PLUGIN_PATH}/subscriptions/lookup`, {
    method: 'POST',
    body: { endpoint: subscription.endpoint }
  })
  return { deviceSubscribed: true, registeredInWorkspace: result.registered }
}

/**
 * Enable notifications for the CURRENT workspace on this device: obtain
 * permission, reuse (or create) the device's push subscription, and register
 * its endpoint with the current scope. Other workspaces' registrations of
 * the same endpoint are untouched.
 */
export async function enableBrowserNotificationsInCurrentWorkspace(): Promise<void> {
  // Browsers only expose Service Workers and the Push API in a secure
  // context, so a self-hosted instance served over plain HTTP can never
  // subscribe. Fail early with an actionable message instead of letting
  // the later `serviceWorker`/`PushManager` access throw a cryptic one.
  if (typeof window !== 'undefined' && window.isSecureContext !== true) {
    throw new Error(
      'Browser notifications require a secure (HTTPS) connection. Serve PrintStream over HTTPS, then try again.'
    )
  }

  if (Notification.permission !== 'granted') {
    const result = await Notification.requestPermission()
    if (result !== 'granted') {
      throw new Error('Permission was not granted')
    }
  }

  const registration = await getRegistration()
  if (!registration) throw new Error('Service worker is not ready yet — refresh and try again')

  const info = await apiFetch<PluginInfo>(BROWSER_NOTIFICATIONS_PLUGIN_PATH)
  if (!info.publicKey) throw new Error('Server did not return a VAPID public key')

  let subscription = await registration.pushManager.getSubscription()
  if (subscription && !subscriptionMatchesServerKey(subscription, info.publicKey)) {
    // The server's VAPID identity changed; the old subscription cannot be
    // signed for anymore and every scope's stored copy of it is dead.
    try { await subscription.unsubscribe() } catch { /* ignore */ }
    subscription = null
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(info.publicKey).buffer as ArrayBuffer
    })
  }

  await apiFetch(`${BROWSER_NOTIFICATIONS_PLUGIN_PATH}/subscriptions`, {
    method: 'POST',
    body: { subscription: subscription.toJSON() }
  })
}

/**
 * Disable notifications for the CURRENT workspace on this device. The
 * browser-level subscription deliberately stays alive: other workspaces may
 * still be registered to deliver through it, and an endpoint no scope holds
 * receives nothing.
 */
export async function disableBrowserNotificationsInCurrentWorkspace(): Promise<void> {
  const subscription = await getCurrentSubscription()
  if (!subscription) return

  await apiFetch(`${BROWSER_NOTIFICATIONS_PLUGIN_PATH}/subscriptions`, {
    method: 'DELETE',
    body: { endpoint: subscription.endpoint }
  })
}
