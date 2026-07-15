/**
 * Settings panel for browser push notifications.
 *
 * The enable/disable state it shows is PER WORKSPACE (resolved server-side
 * via the scope lookup), while permission and the underlying push
 * subscription are per device — the panel surfaces both so "enabled in
 * another workspace but not here" reads as exactly that instead of a
 * mystery toggle.
 */
import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Stack, Typography } from '@mui/joy'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import NotificationsActiveRoundedIcon from '@mui/icons-material/NotificationsActiveRounded'
import NotificationsOffRoundedIcon from '@mui/icons-material/NotificationsOffRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import {
  detectBrowserNotificationsSupport,
  disableBrowserNotificationsInCurrentWorkspace,
  enableBrowserNotificationsInCurrentWorkspace,
  getBrowserNotificationsScopeState,
  type BrowserNotificationsScopeState
} from './subscription'

export function BrowserNotificationsPanel() {
  const support = detectBrowserNotificationsSupport()
  const fullySupported = support.notification && support.serviceWorker && support.pushManager
  const [permission, setPermission] = useState<NotificationPermission>(
    support.notification ? Notification.permission : 'denied'
  )
  const [scopeState, setScopeState] = useState<BrowserNotificationsScopeState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!fullySupported) return
    try {
      setScopeState(await getBrowserNotificationsScopeState())
    } catch {
      // Leave the state unknown; the enable action still works and refreshes.
      setScopeState(null)
    }
  }, [fullySupported])

  useEffect(() => { void refresh() }, [refresh])

  const enable = async () => {
    setError(null)
    setBusy(true)
    try {
      await enableBrowserNotificationsInCurrentWorkspace()
      setPermission(Notification.permission)
      setScopeState({ deviceSubscribed: true, registeredInWorkspace: true })
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
      await disableBrowserNotificationsInCurrentWorkspace()
      setScopeState({ deviceSubscribed: true, registeredInWorkspace: false })
    } catch (caught) {
      setError((caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!support.secureContext) {
    return (
      <Alert color="warning" variant="soft" size="sm" startDecorator={<WarningAmberRoundedIcon />}>
        Browser notifications need a secure (HTTPS) connection. This page is loaded over HTTP, so your
        browser blocks the Service Worker and Push APIs they rely on. Serve PrintStream over HTTPS (or
        reach it via localhost) to enable them.
      </Alert>
    )
  }

  if (!fullySupported) {
    return (
      <Alert color="warning" variant="soft" size="sm" startDecorator={<WarningAmberRoundedIcon />}>
        This browser does not support background push notifications (requires Notification API,
        Service Workers, and PushManager).
      </Alert>
    )
  }

  const enabledHere = scopeState?.registeredInWorkspace === true
  const enabledElsewhereOnly = scopeState?.deviceSubscribed === true && !enabledHere

  return (
    <Stack spacing={1}>
      <Typography level="body-sm" textColor="text.tertiary">
        Receive OS notifications on this device for this workspace's enabled events, even when the
        app is closed. Enable notifications separately in each workspace you want them for; the
        setting applies per browser/device.
      </Typography>
      {permission === 'denied' && (
        <Alert color="danger" variant="soft" size="sm" startDecorator={<ErrorOutlineRoundedIcon />}>
          Notifications are blocked for this site. Allow them in your browser settings, then reload.
        </Alert>
      )}
      {enabledElsewhereOnly && (
        <Typography level="body-sm" textColor="text.tertiary">
          This device already receives notifications for another workspace. Enabling here adds this
          workspace without affecting the others.
        </Typography>
      )}
      {error && <Alert color="danger" variant="soft" size="sm" startDecorator={<ErrorOutlineRoundedIcon />}>{error}</Alert>}
      <Stack direction="row" spacing={1}>
        {enabledHere ? (
          <Button size="sm" color="neutral" variant="outlined" startDecorator={<NotificationsOffRoundedIcon />} loading={busy} onClick={disable}>
            Disable in this workspace
          </Button>
        ) : (
          <Button size="sm" loading={busy} startDecorator={<NotificationsActiveRoundedIcon />} onClick={enable} disabled={permission === 'denied'}>
            Enable in this workspace
          </Button>
        )}
      </Stack>
    </Stack>
  )
}
