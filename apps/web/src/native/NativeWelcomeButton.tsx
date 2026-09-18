/** Non-destructive escape to the bundled chooser, shared by auth and public pages. */
import { Alert, Button, Stack } from '@mui/joy'
import { useState } from 'react'
import { PrintStreamInstance } from './bridge'
import { clearNativeReturnPath } from './navigation'

export function NativeWelcomeButton({ label = 'Back to start' }: { label?: string }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)

  async function returnToWelcome() {
    setPending(true)
    setError(false)
    try {
      await PrintStreamInstance.welcome()
      clearNativeReturnPath()
    } catch {
      console.warn('Could not return to the native welcome screen.')
      setError(true)
    } finally {
      setPending(false)
    }
  }

  return <Stack spacing={1}>
    <Button size="sm" variant="plain" color="neutral" loading={pending} onClick={() => { void returnToWelcome() }}>{label}</Button>
    {error && <Alert color="warning">Could not return to the start screen. Please try again. Your session has not been changed.</Alert>}
  </Stack>
}
