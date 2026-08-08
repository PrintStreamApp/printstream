/**
 * What adding this printer will do to a licensed install's bill or its cap, said
 * in the add-printer dialog before the form is filled in.
 *
 * The core counterpart of the cloud's `PrinterBillingNotice`, and it exists for
 * the same reason: a silent price increase is a trust (and chargeback) problem,
 * and a refusal the user could not have read about first is just a dead end.
 * Only the two builds differ — this one reads the installed licence, that one
 * reads the workspace's plan — so they never render together (the cloud is not
 * an enforcing build, and a self-hosted install has no billing module).
 *
 * Three states, and nothing otherwise:
 * - **Metered, at the allowance.** The add raises the entitlement, which CHARGES
 *   immediately. This is the one the whole file is for.
 * - **Capped and not metered, at the allowance.** The add will be refused; the
 *   cap appears nowhere else in the app.
 * - **Uncapped, or still inside the allowance.** Silent.
 *
 * Counterparts: `apps/api/src/lib/printer-quota.ts` decides the add,
 * `apps/api/src/lib/license-entitlement-client.ts` is what does the buying, and
 * `apps/api/src/routes/license.ts` reports the install-wide count this reads.
 */
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import WarningRoundedIcon from '@mui/icons-material/WarningRounded'
import { Alert, Typography } from '@mui/joy'
import type { LicenseStatusResponse } from '@printstream/shared'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../lib/apiClient'

export function LicensedPrinterBillingNotice() {
  const licenseQuery = useQuery({
    queryKey: ['license'],
    queryFn: ({ signal }) => apiFetch<LicenseStatusResponse>('/api/license', { signal }),
    meta: { suppressGlobalErrorToast: true }
  })

  const data = licenseQuery.data
  // Silent on the cloud and on any build that does not enforce a licence, and
  // silent while loading -- this is additive to a dialog that already works, so
  // a spinner here would report a problem the user does not have.
  if (!data?.enforcement.enforced) return null
  const { status, printerCount } = data
  const allowance = status.maxPrinters
  if (allowance == null || printerCount < allowance) return null

  if (status.metered) {
    return (
      <Alert color="primary" variant="soft" startDecorator={<InfoOutlinedIcon />}>
        <Typography level="body-sm">
          Your license covers {allowance} {allowance === 1 ? 'printer' : 'printers'} and you already
          have {printerCount}. Adding this one increases your subscription, charged prorated for the
          current billing period. Removing a printer credits the difference the same way.
        </Typography>
      </Alert>
    )
  }

  return (
    <Alert color="warning" variant="soft" startDecorator={<WarningRoundedIcon />}>
      <Typography level="body-sm">
        Your license covers {allowance} {allowance === 1 ? 'printer' : 'printers'} and you already
        have {printerCount}, so this one cannot be added yet. The printers you already have keep
        working either way.
      </Typography>
    </Alert>
  )
}
