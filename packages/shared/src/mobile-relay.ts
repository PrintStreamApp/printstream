/** Firebase-only relay contract. A grant is delivered to the phone by FCM, never to the enrollment caller. */
import { z } from 'zod'
import { mobileCanonicalOriginSchema } from './mobile.js'

export const MOBILE_RELAY_ORIGIN = 'https://printstream.app'
export const MOBILE_RELAY_PATH = '/api/mobile-relay'
export const MOBILE_RELAY_LEASE_MS = 30 * 24 * 60 * 60 * 1000
export const MOBILE_NOTIFICATION_PRIVACY_NOTICE = 'Notifications use Google Firebase. For self-hosted servers without their own Firebase setup, enabling notifications sends your device token and an opaque device handle to PrintStream Cloud. Notification text, routes, and image links are encrypted for this device before they leave your server, so PrintStream Cloud cannot read them. Camera image files stay on your server. Disable notifications here to revoke this device enrollment.'

export const mobileRelayEnrollSchema = z.object({
  token: z.string().min(20).max(4096),
  bindingId: z.string().uuid(),
  challenge: z.string().uuid()
}).strict()

export const mobileRelayGrantSchema = z.string().regex(/^psr1\.[a-f0-9]{32}\.[a-f0-9]{64}$/)

/** Routes remain relative: the relay never fetches an instance URL or image. */
const mobileRelayNotificationDataSchema = z.object({
  kind: z.literal('notification'),
  id: z.string().min(1).max(180),
  bindingId: z.string().uuid(),
  origin: mobileCanonicalOriginSchema,
  scope: z.string().max(200),
  title: z.string().max(160),
  body: z.string().max(600),
  level: z.enum(['info', 'warning', 'error', 'success']),
  tag: z.string().max(180),
  url: z.string().max(1000),
  image: z.string().max(1000),
  timestamp: z.string().datetime()
}).strict()

const mobileRelayDismissDataSchema = z.object({
  kind: z.literal('dismiss'),
  id: z.string().max(200),
  bindingId: z.string().uuid(),
  origin: mobileCanonicalOriginSchema,
  tag: z.string().max(180)
}).strict()

/** Both visible alerts and retractions stay opaque to the cloud relay. */
export const mobileRelayDataSchema = z.discriminatedUnion('kind', [
  mobileRelayNotificationDataSchema,
  mobileRelayDismissDataSchema
])

/** Opaque FCM data envelope. Only the enrolled Android Keystore key can open it. */
export const mobileRelayEncryptedDataSchema = z.object({
  kind: z.literal('relay-message'),
  version: z.literal('1'),
  bindingId: z.string().uuid(),
  encryptedKey: z.string().regex(/^[A-Za-z0-9_-]+$/).max(700),
  iv: z.string().regex(/^[A-Za-z0-9_-]+$/).max(40),
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]+$/).max(4000),
  authTag: z.string().regex(/^[A-Za-z0-9_-]+$/).max(40)
}).strict()

export const mobileRelaySendSchema = z.object({
  grant: mobileRelayGrantSchema,
  data: mobileRelayEncryptedDataSchema
}).strict()

export type MobileRelayEnrollment = z.infer<typeof mobileRelayEnrollSchema>
export type MobileRelayData = z.infer<typeof mobileRelayDataSchema>
export type MobileRelayEncryptedData = z.infer<typeof mobileRelayEncryptedDataSchema>
