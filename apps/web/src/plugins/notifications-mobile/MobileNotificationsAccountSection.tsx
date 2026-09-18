/** Account shortcut to the same per-phone choices as App settings; no workspace plugin toggles. */
import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Stack, Typography } from '@mui/joy'
import NotificationsActiveRoundedIcon from '@mui/icons-material/NotificationsActiveRounded'
import { AccountNotificationChannelCard } from '../../components/AccountNotificationChannelCard'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { apiFetch } from '../../lib/apiClient'
import { hasNativeNotifications, nativeNotificationState } from '../../native/notifications'
import { notificationScopes } from '../../native/notificationScopes'
import { openAppNotificationSettings, subscribeNotificationSettingsChanged } from '../../native/appSettings'

export function MobileNotificationsAccountSection() {
  const bootstrap = useAuthBootstrapQuery().data
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const current = useRef(bootstrap)
  current.current = bootstrap
  useEffect(() => subscribeNotificationSettingsChanged(() => setRevision((value) => value + 1)), [])
  useEffect(() => {
    let active = true
    setEnabled(false)
    setMessage(null)
    setError(null)
    if (hasNativeNotifications() && bootstrap?.actor.type === 'user') {
      void nativeNotificationState(bootstrap).then((state) => {
        if (active) setEnabled(state.enabled && state.permission)
      }).catch(() => { if (active) setError('Could not read notification status.') })
    }
    return () => { active = false }
  }, [bootstrap, revision])
  if (!hasNativeNotifications() || !notificationScopes(bootstrap).length) return null

  async function test() {
    const snapshot = bootstrap
    setBusy(true)
    setError(null)
    try {
      await apiFetch('/api/plugins/notifications-mobile/test', {
        method: 'POST', timeoutMs: 15_000,
        headers: { 'X-PrintStream-Workspace': bootstrap!.workspace?.slug ?? 'platform' }
      })
      if (current.current === snapshot) setMessage('Test notification sent to your enrolled devices.')
    } catch {
      if (current.current === snapshot) setError('Could not send a test notification.')
    } finally {
      setBusy(false)
    }
  }

  return <AccountNotificationChannelCard icon={<NotificationsActiveRoundedIcon />} title="This Android device">
    <Stack spacing={1}>
      <Typography level="body-sm">Choose which workspaces send alerts to this phone.</Typography>
      {error && <Alert color="danger">{error}</Alert>}
      {message && <Alert color="success">{message}</Alert>}
      <Stack direction="row" spacing={1}>
        <Button size="sm" onClick={openAppNotificationSettings}>Notification settings</Button>
        {enabled && <Button size="sm" variant="outlined" loading={busy} onClick={() => void test()}>Send test</Button>}
      </Stack>
    </Stack>
  </AccountNotificationChannelCard>
}
