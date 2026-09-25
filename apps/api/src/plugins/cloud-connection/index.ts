/**
 * Optional self-hosted PrintStream Cloud connection. Phase 1 exposes
 * user-initiated licensed-support and suggestion relays. It opens no background
 * connection; suggestions use the licence Customer as their shared identity.
 */
import type { ApiPlugin } from '../../plugin/types.js'
import { SETTINGS_MANAGE_PERMISSION, canUseSuggestions, hasInAppSupport, inAppSupportUnavailabilityReason } from '@printstream/shared'
import { requireRequestPermission } from '../../lib/authorization.js'
import { getInstalledLicenseStatus } from '../../lib/license-state.js'
import { registerCloudConnectionRelays } from './relay.js'

export const cloudConnectionPlugin: ApiPlugin = {
  name: 'cloud-connection',
  version: '0.1.0',
  description: 'Licensed in-app support and product suggestions from PrintStream Cloud. Enabled by default, but contacts the cloud only when either surface is used.',
  register(context) {
    context.router.get('/status', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (_request, response) => {
      const status = await getInstalledLicenseStatus()
      const reason = inAppSupportUnavailabilityReason(status)
      response.json({
        eligible: hasInAppSupport(status),
        reason,
        suggestionsEligible: canUseSuggestions(status)
      })
    })
    registerCloudConnectionRelays(context.router)
  }
}
