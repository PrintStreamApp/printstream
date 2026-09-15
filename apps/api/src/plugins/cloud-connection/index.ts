/**
 * Optional self-hosted PrintStream Cloud connection. Phase 1 exposes
 * user-initiated licensed-support and suggestion relays. It opens no background
 * connection; suggestions use the licence Customer as their shared identity.
 */
import type { ApiPlugin } from '../../plugin/types.js'
import { SETTINGS_MANAGE_PERMISSION } from '@printstream/shared'
import { requireRequestPermission } from '../../lib/authorization.js'
import { getInstalledLicenseStatus } from '../../lib/license-state.js'
import { registerCloudConnectionRelays } from './relay.js'

/** Explain why the installed licence cannot currently authenticate cloud features. */
function supportIneligibilityReason(status: Awaited<ReturnType<typeof getInstalledLicenseStatus>>): string | null {
  if (!status.valid) return 'Install a valid commercial license to use cloud support and suggestions.'
  if (status.edition !== 'commercial') return 'Community licenses use email support and do not include the suggestion board.'
  if (status.updatesExpired) return 'Renew updates and support to use cloud support and suggestions.'
  return null
}

export const cloudConnectionPlugin: ApiPlugin = {
  name: 'cloud-connection',
  version: '0.1.0',
  description: 'Licensed in-app support and product suggestions from PrintStream Cloud. Enabled by default, but contacts the cloud only when either surface is used.',
  register(context) {
    context.router.get('/status', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (_request, response) => {
      const status = await getInstalledLicenseStatus()
      const reason = supportIneligibilityReason(status)
      response.json({
        eligible: reason === null,
        reason
      })
    })
    registerCloudConnectionRelays(context.router)
  }
}
