/** FCM HTTP v1 transport. Credentials stay server-side; failures never log tokens or payloads. */
import type { NotificationMessage } from '@printstream/shared'
import { env } from './env.js'

let authPromise: Promise<import('google-auth-library').GoogleAuth> | undefined

export function isMobilePushConfigured(): boolean {
  return Boolean(env.FCM_SERVICE_ACCOUNT_FILE && env.FCM_PROJECT_ID)
}

/** Bounded data-only payload; Android displays it without a running WebView. */
export function buildMobilePushData(message: NotificationMessage, origin: string, bindingId: string, scope: string | null) {
  const route = (value?: string): string => {
    try {
      const url = new URL(value ?? '/', origin)
      return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : '/'
    } catch {
      return '/'
    }
  }
  const data = {
    kind: 'notification', id: message.id, bindingId, origin, scope: scope ?? '',
    title: message.title.slice(0, 160), body: message.body.slice(0, 600),
    level: message.level, tag: (message.tag ?? message.id).slice(0, 180),
    url: route(message.url), image: message.imageUrl ? route(message.imageUrl) : '',
    timestamp: message.timestamp
  }
  // FCM limits the entire message to 4 KB, including multibyte text and routing fields.
  while (Buffer.byteLength(JSON.stringify(data)) > 3000 && data.body.length > 0) {
    data.body = data.body.slice(0, Math.floor(data.body.length / 2))
  }
  if (Buffer.byteLength(JSON.stringify(data)) > 3000) throw new Error('Mobile push metadata exceeds payload budget')
  return data
}

/** A native retraction carries only the stable grouping data Android needs. */
export function buildMobileDismissData(tag: string, notificationId: string | undefined, origin: string, bindingId: string) {
  return { kind: 'dismiss', tag: tag.slice(0, 180), id: notificationId?.slice(0, 200) ?? '', origin, bindingId }
}

/** Only UNREGISTERED retires a token; permission/project errors must not erase devices. */
export function isUnregisteredFcmResponse(value: unknown): boolean {
  const details = (value as { error?: { details?: Array<{ errorCode?: string }> } })?.error?.details
  return Array.isArray(details) && details.some((entry) => entry?.errorCode === 'UNREGISTERED')
}

async function accessToken(): Promise<string> {
  authPromise ??= (async () => {
    const { GoogleAuth } = await import('google-auth-library')
    return new GoogleAuth({ keyFilename: env.FCM_SERVICE_ACCOUNT_FILE,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging'] })
  })()
  try {
    const token = await (await authPromise).getAccessToken()
    if (!token) throw new Error('No FCM access token')
    return token
  } catch {
    authPromise = undefined
    throw new Error('FCM authentication failed; check server credentials')
  }
}

/** False means an expired device token. Auth/transient errors get one bounded retry. */
export async function sendMobilePush(token: string, data: Record<string, string>): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(env.FCM_PROJECT_ID ?? '')}/messages:send`, {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token, data, android: {
        priority: 'HIGH', ttl: '300s', restricted_package_name: 'app.printstream'
      } } })
    })
    if (response.ok) return true
    const failure: unknown = await response.json().catch(() => null)
    if (isUnregisteredFcmResponse(failure)) return false
    if (attempt === 0 && response.status === 401) {
      authPromise = undefined
      continue
    }
    if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
      const delay = Math.min(5000, Math.max(1000, Number(response.headers.get('Retry-After') ?? 1) * 1000))
      await new Promise((resolve) => setTimeout(resolve, Number.isFinite(delay) ? delay : 1000))
      continue
    }
    throw new Error(`FCM delivery failed (HTTP ${response.status})`)
  }
  throw new Error('FCM delivery retries exhausted')
}
