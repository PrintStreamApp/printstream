/** Personal desktop preferences, reusing the native account and dialog conventions. */
import { useEffect, useRef, useState } from 'react'
import { nativeNotificationAccount } from '@printstream/shared'
import { Button, Checkbox, Stack, Typography } from '@mui/joy'
import { FormDialog } from '../../components/FormDialog'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { desktopRequest, supportsDesktopNotifications } from '../../native/desktopBridge'
import { notificationScopes } from '../../native/notificationScopes'
import { finishAppNotificationSettings, hasAppNotificationSettingsRequest, subscribeAppNotificationSettings, takeAppNotificationSettingsRequest } from '../../native/appSettings'

interface Preferences { enabled: string[]; asked: boolean }

/** Explicit consent is per origin/account/scope; bootstrap changes never enable new scopes. */
export function DesktopNotificationSettings() {
  const settingsEntry = useRef(hasAppNotificationSettingsRequest())
  const bootstrap = useAuthBootstrapQuery().data
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [saved, setSaved] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const hasBootstrap = Boolean(bootstrap)
  const scopes = notificationScopes(bootstrap)
  const account = nativeNotificationAccount(bootstrap) ?? ''
  const scopeKey = JSON.stringify(scopes.map(({ id, name, bootstrap: scope }) => ({
    id, name, slug: scope.workspace?.slug ?? 'platform'
  })))

  const contextKey = `${account}:${scopeKey}:${revision}`
  const currentContext = useRef(contextKey)
  currentContext.current = contextKey

  useEffect(() => subscribeAppNotificationSettings(() => {
    setOpen(true)
    setRevision((value) => value + 1)
  }), [])

  useEffect(() => {
    if (!supportsDesktopNotifications() || !hasBootstrap || !account) return
    let active = true
    setError(null)
    setLoading(true)
    setBusy(false)

    /** Child effects can run before the shell's connection-confirmation effect. */
    async function loadPreferences() {
      try {
        await desktopRequest('enterApp')
        if (!active) return

        const preferences = await desktopRequest<Preferences>('notifications.sync', {
          account, scopes: JSON.parse(scopeKey)
        })
        if (!active) return

        setSelected(preferences.enabled)
        setSaved(preferences.enabled)
        // Consume only after loading an eligible account; auth redirects and failed reads must retain the request.
        if (scopeKey !== '[]' || settingsEntry.current) {
          const requested = takeAppNotificationSettingsRequest()
          if (requested || !preferences.asked) setOpen(true)
        }
      } catch {
        if (active) setError('Could not read desktop notification settings.')
      } finally {
        if (active) setLoading(false)
      }
    }

    void loadPreferences()
    return () => { active = false }
  }, [account, scopeKey, hasBootstrap, revision])

  if (!supportsDesktopNotifications() || !account || (!scopes.length && !settingsEntry.current)) return null

  /** Closing records the prior consent, never the checkbox edits being cancelled. */
  async function save(enabled: string[]) {
    setBusy(true)
    setError(null)
    try {
      await desktopRequest('notifications.save', { account, enabled })
      if (currentContext.current !== contextKey) return

      setSelected(enabled)
      setSaved(enabled)
      await finishAppNotificationSettings()
      setOpen(false)
    } catch {
      if (currentContext.current === contextKey) {
        setError('Could not save desktop notification settings. Please try again.')
      }
    } finally {
      if (currentContext.current === contextKey) setBusy(false)
    }
  }

  /** Ask the native presenter to verify Notification Center independently of printer events. */
  async function testNotifications() {
    try {
      await desktopRequest('notifications.test')
    } catch {
      if (currentContext.current === contextKey) setError('This computer could not display a test notification.')
    }
  }

  return <FormDialog open={open} title="App settings: Notifications"
    description="Choose which workspaces send alerts to this computer."
    submitLabel="Save" cancelLabel="Not now" busy={busy || loading} error={error}
    onClose={() => { void save(saved) }} onSubmit={() => { void save(selected) }}>
    <Stack spacing={2}>
      {scopes.length === 0 && <Typography>No notification workspaces are available for this account.</Typography>}
      {scopes.map((scope) => <Checkbox key={scope.id} label={scope.name}
        checked={selected.includes(scope.id)} disabled={busy || loading}
        onChange={(event) => setSelected((previous) => event.target.checked
          ? [...previous, scope.id] : previous.filter((id) => id !== scope.id))} />)}
      <Typography level="body-sm">Alerts arrive directly from your servers while PrintStream runs in the background. Quitting PrintStream stops alerts. Offline alerts are retained for up to one hour, subject to server capacity; restarting the server clears pending alerts.</Typography>
      <Button size="sm" variant="plain" disabled={busy || loading}
        onClick={() => { void testNotifications() }}>Test desktop notifications</Button>
    </Stack>
  </FormDialog>
}
