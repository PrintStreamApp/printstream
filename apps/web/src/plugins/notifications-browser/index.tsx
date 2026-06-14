/**
 * Browser-native notifications plugin (web side).
 *
 * Pairs with the API plugin `notifications-browser`, which signs and
 * sends Web Push messages to subscribed browsers. The actual
 * notification is shown by the service worker (see
 * `apps/web/public/push-handler.js`), so notifications fire even when
 * no PrintStream tab is open.
 *
 * This plugin only contributes a settings panel: it requests
 * notification permission, asks the browser's `PushManager` to create
 * a subscription using the server's VAPID public key, and POSTs the
 * resulting subscription to the API. The server's matching DELETE
 * endpoint is hit when the user disables.
 *
 * Per-device opt-in/permission state is intrinsic to the
 * `PushSubscription` itself, so we don't shadow it in localStorage —
 * the source of truth is `registration.pushManager.getSubscription()`.
 */
/* eslint-disable react-refresh/only-export-components -- plugin entry exports a component intentionally */
import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Stack, Typography } from '@mui/joy'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import NotificationsActiveRoundedIcon from '@mui/icons-material/NotificationsActiveRounded'
import NotificationsOffRoundedIcon from '@mui/icons-material/NotificationsOffRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import {
  SETTINGS_MANAGE_PERMISSION
} from '@printstream/shared'
import type { WebPlugin } from '../../plugin/types'
import { apiFetch } from '../../lib/apiClient'
import { waitForAuthBootstrapData, waitForPluginCatalogData } from '../../lib/appShellQueryData'
import { toast } from '../../lib/toast'
import {
  dismissEnrollmentPrompt,
  isBrowserNotificationsPluginEnabled,
  readEnrollmentPromptDismissed,
  shouldShowBrowserNotificationEnrollmentPrompt
} from './prompt'

interface PluginInfo {
  publicKey: string
  subscriptions: number
}

const PLUGIN_PATH = '/api/plugins/notifications-browser'

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

interface SupportState {
  notification: boolean
  serviceWorker: boolean
  pushManager: boolean
}

export function detectBrowserNotificationsSupport(): SupportState {
  if (typeof window === 'undefined') {
    return { notification: false, serviceWorker: false, pushManager: false }
  }
  return {
    notification: 'Notification' in window,
    serviceWorker: 'serviceWorker' in navigator,
    pushManager: 'PushManager' in window
  }
}

export async function hasBrowserNotificationsSubscription(): Promise<boolean> {
  return Boolean(await getCurrentSubscription())
}

export async function enableBrowserNotificationsOnCurrentDevice(): Promise<void> {
  if (Notification.permission !== 'granted') {
    const result = await Notification.requestPermission()
    if (result !== 'granted') {
      throw new Error('Permission was not granted')
    }
  }

  const registration = await getRegistration()
  if (!registration) throw new Error('Service worker is not ready yet — refresh and try again')

  const info = await apiFetch<PluginInfo>(PLUGIN_PATH)
  if (!info.publicKey) throw new Error('Server did not return a VAPID public key')

  const existing = await registration.pushManager.getSubscription()
  if (existing) {
    try { await existing.unsubscribe() } catch { /* ignore */ }
  }

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(info.publicKey).buffer as ArrayBuffer
  })

  await apiFetch(`${PLUGIN_PATH}/subscriptions`, {
    method: 'POST',
    body: { subscription: subscription.toJSON() }
  })
}

export async function disableBrowserNotificationsOnCurrentDevice(): Promise<void> {
  const subscription = await getCurrentSubscription()
  if (!subscription) return

  try {
    await apiFetch(`${PLUGIN_PATH}/subscriptions`, {
      method: 'DELETE',
      body: { endpoint: subscription.endpoint }
    })
  } catch {
    // server-side cleanup is best-effort
  }

  try { await subscription.unsubscribe() } catch { /* ignore */ }
}

async function promptForBrowserNotificationEnrollmentOnAppLoad(): Promise<void> {
  const support = detectBrowserNotificationsSupport()
  if (typeof window === 'undefined') return

  let bootstrap
  try {
    bootstrap = await waitForAuthBootstrapData()
  } catch {
    return
  }

  if (bootstrap.authEnabled && !bootstrap.permissions.includes(SETTINGS_MANAGE_PERMISSION)) {
    return
  }

  let pluginEnabled = false
  try {
    const catalog = await waitForPluginCatalogData()
    pluginEnabled = isBrowserNotificationsPluginEnabled(catalog.plugins)
  } catch {
    return
  }

  const subscribed = await hasBrowserNotificationsSubscription().catch(() => false)
  if (!shouldShowBrowserNotificationEnrollmentPrompt({
    pluginEnabled,
    support,
    permission: support.notification ? Notification.permission : 'denied',
    subscribed,
    dismissed: readEnrollmentPromptDismissed()
  })) {
    return
  }

  toast.info({
    message: 'Enable browser background notifications on this device?',
    durationMs: 0,
    action: {
      label: 'Enable',
      onClick: async () => {
        try {
          await enableBrowserNotificationsOnCurrentDevice()
          toast.success('Browser notifications enabled on this device')
        } catch (caught) {
          toast.error((caught as Error).message)
        }
      }
    },
    onClose: (reason) => {
      if (reason === 'dismiss') dismissEnrollmentPrompt()
    }
  })
}

function BrowserNotificationsPanel() {
  const support = detectBrowserNotificationsSupport()
  const fullySupported = support.notification && support.serviceWorker && support.pushManager
  const [permission, setPermission] = useState<NotificationPermission>(
    support.notification ? Notification.permission : 'denied'
  )
  const [subscribed, setSubscribed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!fullySupported) return
    const sub = await getCurrentSubscription()
    setSubscribed(Boolean(sub))
  }, [fullySupported])

  useEffect(() => { void refresh() }, [refresh])

  const enable = async () => {
    setError(null)
    setBusy(true)
    try {
      await enableBrowserNotificationsOnCurrentDevice()
      setPermission(Notification.permission)
      setSubscribed(true)
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    setError(null)
    setBusy(true)
    try {
      await disableBrowserNotificationsOnCurrentDevice()
      setSubscribed(false)
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!fullySupported) {
    return (
      <Alert color="warning" variant="soft" size="sm" startDecorator={<WarningAmberRoundedIcon />}>
        This browser does not support background push notifications (requires Notification API,
        Service Workers, and PushManager).
      </Alert>
    )
  }

  return (
    <Stack spacing={1}>
      <Typography level="body-sm" textColor="text.tertiary">
        Receive OS notifications on this device for enabled print events, even when the app is
        closed. Permission is stored per browser/device.
      </Typography>
      {permission === 'denied' && (
        <Alert color="danger" variant="soft" size="sm" startDecorator={<ErrorOutlineRoundedIcon />}>
          Notifications are blocked for this site. Allow them in your browser settings, then reload.
        </Alert>
      )}
      {error && <Alert color="danger" variant="soft" size="sm" startDecorator={<ErrorOutlineRoundedIcon />}>{error}</Alert>}
      <Stack direction="row" spacing={1}>
        {subscribed ? (
          <Button size="sm" color="neutral" variant="outlined" startDecorator={<NotificationsOffRoundedIcon />} loading={busy} onClick={disable}>
            Disable on this device
          </Button>
        ) : (
          <Button size="sm" loading={busy} startDecorator={<NotificationsActiveRoundedIcon />} onClick={enable} disabled={permission === 'denied'}>
            Enable on this device
          </Button>
        )}
      </Stack>
    </Stack>
  )
}

export const notificationsBrowserPlugin: WebPlugin = {
  name: 'notifications-browser',
  version: '0.2.0',
  description: 'Background OS notifications via Web Push (works when the app is closed).',
  settingsPanel: BrowserNotificationsPanel,
  init() {
    void promptForBrowserNotificationEnrollmentOnAppLoad()
  }
}
