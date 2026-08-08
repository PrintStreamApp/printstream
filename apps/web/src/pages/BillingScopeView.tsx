/**
 * The page behind the billing scope: whatever the cloud module contributes to
 * the `billing.scope` slot, for the account named in the URL.
 *
 * Core owns the route because the workspace switcher is core and has to be able
 * to navigate somewhere; the CONTENT is cloud-only, so a public build fills no
 * slot, the route is never registered, and the switcher never offers the entry.
 *
 * The account id and section are passed through the slot context rather than
 * read by the private view, so the route pattern stays owned by
 * `lib/billingScope.ts` and the two cannot disagree about the parameter names.
 */
import { useParams } from 'react-router-dom'
import { StaticPluginSlot } from '../plugin/StaticPluginSlot'
import { BILLING_SCOPE_SLOT } from '../lib/billingScope'

export function BillingScopeView() {
  const { customerId, section } = useParams()
  return <StaticPluginSlot name={BILLING_SCOPE_SLOT} context={{ customerId, section }} />
}
