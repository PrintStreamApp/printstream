/** Desktop host notification feed. Cursors are opaque and never grant access. */
import { z } from 'zod'

export const desktopNotificationQuerySchema = z.object({
  cursor: z.string().max(100).optional()
})

export const desktopNotificationEventSchema = z.object({
  id: z.string(),
  type: z.enum(['notification', 'dismiss']),
  tag: z.string(),
  /** Owning scope, which may differ from the enrolled scope used to poll. */
  workspaceId: z.string().nullable().optional(),
  /** A personal dismissal can retract the same tag across enrolled scopes. */
  crossScope: z.boolean().optional(),
  notificationId: z.string().optional(),
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
