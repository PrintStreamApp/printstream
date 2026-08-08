/**
 * The icon for each billing-scope section.
 *
 * Separate from `lib/billingScope.ts` because that module is plain data with no
 * JSX, and shared rather than duplicated because two places must agree: the
 * shell's tab row (core) and the section heading on the page itself (the cloud
 * module). A tab and the heading it opens showing different icons is the exact
 * drift this prevents.
 *
 * Each one matches the icon its concept already carries elsewhere in the app.
 */
import BusinessRoundedIcon from '@mui/icons-material/BusinessRounded'
import CreditCardRoundedIcon from '@mui/icons-material/CreditCardRounded'
import ForumRoundedIcon from '@mui/icons-material/ForumRounded'
import KeyRoundedIcon from '@mui/icons-material/KeyRounded'
import PeopleRoundedIcon from '@mui/icons-material/PeopleRounded'
import ReceiptLongRoundedIcon from '@mui/icons-material/ReceiptLongRounded'
import SettingsRoundedIcon from '@mui/icons-material/SettingsRounded'
import type { ReactNode } from 'react'
import type { BillingScopeSectionId } from '../lib/billingScope'

export const BILLING_SCOPE_SECTION_ICONS: Record<BillingScopeSectionId, ReactNode> = {
  workspaces: <BusinessRoundedIcon />,
  licenses: <KeyRoundedIcon />,
  people: <PeopleRoundedIcon />,
  messages: <ForumRoundedIcon />,
  payment: <CreditCardRoundedIcon />,
  invoices: <ReceiptLongRoundedIcon />,
  settings: <SettingsRoundedIcon />
}
