/** Device-level settings remain separate from workspace administration. */
import { Alert, Button, Stack } from '@mui/joy'
import { useState } from 'react'
import { isNativeApp, PrintStreamInstance } from './bridge'

export function NativeAppSettingsButton() {
  const [error, setError] = useState(false)
  if (!isNativeApp()) return null
  return <Stack spacing={1}><Button size="sm" variant="plain" color="neutral" onClick={() => {
    setError(false)
    void PrintStreamInstance.menu({ view: 'settings' }).catch(() => {
      console.warn('Could not open app settings.')
      setError(true)
    })
  }}>App settings</Button>
    {error && <Alert color="warning">Could not open app settings. Please try again.</Alert>}
  </Stack>
}
