/** Optional self-hosted delivery through the fixed Firebase relay; never calls it before device enrollment. */
import { MOBILE_RELAY_ORIGIN, MOBILE_RELAY_PATH } from '@printstream/shared'
import { isSelfHostedDeployment } from '../../lib/deployment-mode.js'
import { isMobilePushConfigured, sendMobilePush } from './fcm.js'

/** Direct credentials take precedence; public self-hosted installs use the device-authorized relay. */
export function mobileDeliveryTransport(): 'direct' | 'relay' | 'unavailable' {
  if (isMobilePushConfigured()) return 'direct'
  return isSelfHostedDeployment() ? 'relay' : 'unavailable'
}

/** Relay failures preserve enrollment except when the capability was explicitly refused or the token expired. */
export async function sendMobileNotification(token: string, data: Record<string, string>, transport = 'direct'): Promise<boolean> {
  if (transport === 'direct') return sendMobilePush(token, data)
  if (transport !== 'relay' || !isSelfHostedDeployment()) throw new Error('Unsupported mobile transport')
  const response = await fetch(`${MOBILE_RELAY_ORIGIN}${MOBILE_RELAY_PATH}/send`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25_000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant: token, data })
  })
  if (response.status === 401) return false
  if (!response.ok) throw new Error(`Mobile relay failed (HTTP ${response.status})`)
  const result = await response.json() as { accepted?: boolean }
  if (typeof result.accepted !== 'boolean') throw new Error('Invalid mobile relay response')
  return result.accepted
}
