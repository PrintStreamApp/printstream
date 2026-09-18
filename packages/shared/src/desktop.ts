/** Windows host notification feed. Cursors are opaque and never grant access. */
import { z } from 'zod'

export const desktopNotificationQuerySchema = z.object({
  cursor: z.string().max(100).optional()
})

export const desktopNotificationEventSchema = z.object({
  id: z.string(),
  type: z.enum(['notification', 'dismiss']),
  tag: z.string(),
  title: z.string().optional(),
  body: z.string().optional(),
  url: z.string().optional(),
  imageUrl: z.string().optional()
})
export type DesktopNotificationEvent = z.infer<typeof desktopNotificationEventSchema>

export const desktopNotificationFeedSchema = z.object({
  cursor: z.string(),
  events: z.array(desktopNotificationEventSchema)
})
