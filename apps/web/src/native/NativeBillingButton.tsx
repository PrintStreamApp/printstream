/** Self-hosted billing opens through the native cloud handshake; browser users keep an external cloud link. */
import { useState } from 'react'
import { Alert, Button, Stack } from '@mui/joy'
import { BILLING_SCOPE_LABEL } from '../lib/billingScope'
import { CLOUD_BILLING_ENTRY_URL } from '../lib/licenseUrls'
import { isNativeApp, PrintStreamInstance } from './bridge'

export function NativeBillingButton() {
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)

  async function open(): Promise<void> {
    setError(false)
    setBusy(true)
    try {
      await PrintStreamInstance.menu({ view: 'billing' })
    } catch {
      console.warn('Could not open native billing.')
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  if (!isNativeApp()) return <Button component="a" href={CLOUD_BILLING_ENTRY_URL}
    target="_blank" rel="noopener noreferrer" variant="plain" color="neutral" size="sm">{BILLING_SCOPE_LABEL}</Button>

  return <Stack spacing={1}>
    <Button variant="plain" color="neutral" size="sm" disabled={busy} onClick={() => { void open() }}>{BILLING_SCOPE_LABEL}</Button>
    {error && <Alert color="warning">Could not open billing. Please try again.</Alert>}
  </Stack>
}
