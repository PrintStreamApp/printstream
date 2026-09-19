/** Self-hosted billing menu entry using the native cloud handshake when available. */
import CreditCardRoundedIcon from '@mui/icons-material/CreditCardRounded'
import React from 'react'
import { ListItemDecorator, MenuItem } from '@mui/joy'
import { BILLING_SCOPE_LABEL } from '../lib/billingScope'
import { CLOUD_BILLING_ENTRY_URL } from '../lib/licenseUrls'
import { toast } from '../lib/toast'
import { isNativeApp, PrintStreamInstance } from './bridge'

export function NativeBillingMenuItem() {
  async function openNativeBilling(): Promise<void> {
    try {
      await PrintStreamInstance.menu({ view: 'billing' })
    } catch {
      console.warn('Could not open native billing.')
      toast.error('Could not open billing. Please try again.')
    }
  }

  return isNativeApp() ? (
    <MenuItem onClick={() => { void openNativeBilling() }}>
      <ListItemDecorator><CreditCardRoundedIcon fontSize="small" /></ListItemDecorator>
      {BILLING_SCOPE_LABEL}
    </MenuItem>
  ) : (
    <MenuItem component="a" href={CLOUD_BILLING_ENTRY_URL} target="_blank" rel="noopener noreferrer">
      <ListItemDecorator><CreditCardRoundedIcon fontSize="small" /></ListItemDecorator>
      {BILLING_SCOPE_LABEL}
    </MenuItem>
  )
}
