/** Firebase-only relay contract. A grant is delivered to the phone by FCM, never to the enrollment caller. */
import { z } from 'zod'
import { mobileCanonicalOriginSchema } from './mobile.js'

export const MOBILE_RELAY_ORIGIN = 'https://printstream.app'
export const MOBILE_RELAY_PATH = '/api/mobile-relay'
export const MOBILE_RELAY_LEASE_MS = 30 * 24 * 60 * 60 * 1000
export const MOBILE_NOTIFICATION_PRIVACY_NOTICE = 'Notifications use Google Firebase. For self-hosted servers without their own Firebase setup, enabling notifications sends your device token and server address to PrintStream Cloud and allows that server to relay notification text and image links. Camera image files stay on your server. Disable notifications here to revoke this device enrollment.'

export const mobileRelayEnrollSchema = z.object({
  token: z.string().min(20).max(4096),
  origin: mobileCanonicalOriginSchema,
  bindingId: z.string().uuid(),
  challenge: z.string().uuid()
}).strict()

export const mobileRelayGrantSchema = z.string().regex(/^psr1\.[a-f0-9]{32}\.[a-f0-9]{64}$/)

/** Routes remain relative: the relay never fetches an instance URL or image. */
export const mobileRelayDataSchema = z.object({
  id: z.string().min(1).max(180),
  bindingId: z.string().uuid(),
  origin: mobileCanonicalOriginSchema,
  title: z.string().max(160),
  body: z.string().max(600),
  level: z.enum(['info', 'warning', 'error', 'success']),
  tag: z.string().max(180),
  url: z.string().max(1000),
  image: z.string().max(1000),
  timestamp: z.string().datetime()
}).strict()

export const mobileRelaySendSchema = z.object({
  grant: mobileRelayGrantSchema,
  data: mobileRelayDataSchema
}).strict()

export type MobileRelayEnrollment = z.infer<typeof mobileRelayEnrollSchema>
export type MobileRelayData = z.infer<typeof mobileRelayDataSchema>
