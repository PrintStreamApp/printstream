/** Account shortcut to device-local Windows notification preferences. */
import { useState } from 'react'
import { Alert, Button, Stack, Typography } from '@mui/joy'
import NotificationsActiveRoundedIcon from '@mui/icons-material/NotificationsActiveRounded'
import { AccountNotificationChannelCard } from '../../components/AccountNotificationChannelCard'
import { desktopRequest, isNativeWindows } from '../../native/desktopBridge'

/** Browser and Android clients contribute no Windows-only account controls. */
export function DesktopNotificationAccountSection() {
  const [error, setError] = useState(false)
  if (!isNativeWindows()) return null
  return <AccountNotificationChannelCard icon={<NotificationsActiveRoundedIcon />} title="This Windows device">
    <Stack spacing={1}>
      <Typography level="body-sm">Choose alerts for this computer in App settings.</Typography>
      {error && <Alert color="danger">Could not open app settings.</Alert>}
      <Button size="sm" onClick={() => {
        void desktopRequest('menu', { view: 'settings' }).catch(() => setError(true))
      }}>App settings</Button>
    </Stack>
  </AccountNotificationChannelCard>
}
