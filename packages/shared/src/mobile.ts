/**
 * Versioned handshake an Android shell uses before granting a remote origin
 * access to its Capacitor bridge. This is product discovery, not authentication:
 * account, workspace, and provider state remain in the existing auth bootstrap.
 */
import { z } from 'zod'

/** The mutable cloud licence label, never the owner's identity or credential. */
export const mobileConnectionNameResponseSchema = z.object({ name: z.string().trim().max(120).nullable() })
export type MobileConnectionNameResponse = z.infer<typeof mobileConnectionNameResponseSchema>

export const PRINTSTREAM_MOBILE_PROTOCOL_VERSION = 1 as const

export const mobileDeploymentKindSchema = z.enum(['cloud', 'selfHosted'])
export type MobileDeploymentKind = z.infer<typeof mobileDeploymentKindSchema>

export const mobileNotificationTransportSchema = z.enum(['unavailable', 'direct', 'relay'])
export type MobileNotificationTransport = z.infer<typeof mobileNotificationTransportSchema>

/** Accept only an HTTP(S) origin, never a URL whose path could change app routing. */
export const mobileCanonicalOriginSchema = z.string().url().refine((value) => {
  const url = new URL(value)
  return (url.protocol === 'https:' || url.protocol === 'http:')
    && url.username === ''
    && url.password === ''
    && url.pathname === '/'
    && url.search === ''
    && url.hash === ''
}, 'Canonical origin must be an HTTP(S) origin without credentials, path, query, or fragment.')

export const mobileDiscoveryResponseSchema = z.object({
  product: z.literal('printstream'),
  protocolVersion: z.literal(PRINTSTREAM_MOBILE_PROTOCOL_VERSION),
  canonicalOrigin: mobileCanonicalOriginSchema,
  nativeNavigationVersion: z.literal(1).optional(),
  deployment: mobileDeploymentKindSchema,
  serverVersion: z.string().trim().min(1).max(100).nullable(),
  nativeNotifications: z.object({
    transport: mobileNotificationTransportSchema
  })
})
export type MobileDiscoveryResponse = z.infer<typeof mobileDiscoveryResponseSchema>

/** A device proves its current local enrolment with a random binding, never a URL or user id. */
export const mobilePushRegistrationSchema = z.object({
  token: z.string().min(20).max(4096),
  bindingId: z.string().uuid(),
  transport: z.enum(['direct', 'relay']).default('direct'),
  /** DER SubjectPublicKeyInfo, used only by self-hosted servers to encrypt relay payloads. */
  encryptionPublicKey: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(1024).optional()
})
export type MobilePushRegistration = z.infer<typeof mobilePushRegistrationSchema>

export const mobilePushStateSchema = z.object({
  configured: z.boolean(),
  registered: z.boolean()
})
export type MobilePushState = z.infer<typeof mobilePushStateSchema>
