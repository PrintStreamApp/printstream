/** Device-level settings remain separate from workspace administration. */
import { Alert, Stack } from '@mui/joy'
import { useState } from 'react'
import { SettingsOverviewCard } from '../components/settings/SettingsOverviewCard'
import { isNativeApp, PrintStreamInstance } from './bridge'

export function NativeAppSettingsButton() {
  const [error, setError] = useState(false)
  if (!isNativeApp()) return null

  return (
    <Stack spacing={1} sx={{ width: '100%' }}>
      <SettingsOverviewCard
        title="App settings"
        description="Connections, notifications, and preferences for this device."
        onAction={() => {
          setError(false)
          void PrintStreamInstance.menu({ view: 'settings' }).catch(() => {
            console.warn('Could not open app settings.')
            setError(true)
          })
        }}
      />
      {error && <Alert color="warning">Could not open app settings. Please try again.</Alert>}
    </Stack>
  )
}
