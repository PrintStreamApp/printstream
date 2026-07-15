/**
 * Notification contracts shared between the API and web app.
 *
 * Notification plugins on the server format printer events into a
 * `NotificationMessage` and deliver them through their own channel
 * (ntfy webhook, Discord webhook, browser push, etc). The browser
 * notifications plugin delivers them as Web Push messages (VAPID-signed,
 * via the `web-push` library) to each subscribed browser, which displays
 * them through the Notification API.
 *
 * Keeping this in `@printstream/shared` means every channel agrees on
 * the same shape without any plugin importing another.
 */
import { z } from 'zod'

export const notificationLevelSchema = z.enum(['info', 'success', 'warning', 'error'])
export type NotificationLevel = z.infer<typeof notificationLevelSchema>

export const notificationCategorySchema = z.enum([
  'job.started',
  'job.paused',
  'job.error',
  'job.finished',
  'printer.added',
  'printer.removed',
  'bridge.crashed',
  'system'
])
export type NotificationCategory = z.infer<typeof notificationCategorySchema>

/**
 * Stable identifiers for the notification triggers PrintStream knows about.
 * Each event has its own editable title/body template so users can tune
 * wording per-channel without forking notification plugins. Splitting
 * `job.finished` per result lets users say e.g. "🎉" for success and
 * "⚠️" for failure.
 */
export const notificationTemplateEventSchema = z.enum([
  'job.started',
  'job.paused',
  'job.error',
  'job.finished.success',
  'job.finished.failed',
  'job.finished.cancelled',
  'bridge.crashed'
])
export type NotificationTemplateEvent = z.infer<typeof notificationTemplateEventSchema>

/**
 * Variables a template author may reference for each event. Strings are
 * substituted via `{{name}}` placeholders by the API; unknown variables
 * are left untouched so users see the raw token and can fix the template.
 */
export const notificationTemplateVariables: Record<NotificationTemplateEvent, readonly string[]> = {
  'job.started': ['printerName', 'jobName'],
  'job.paused': ['printerName', 'jobName', 'reason'],
  'job.error': ['printerName', 'jobName', 'errorMessage', 'errorCode'],
  'job.finished.success': ['printerName', 'jobName', 'result'],
  'job.finished.failed': ['printerName', 'jobName', 'result'],
  'job.finished.cancelled': ['printerName', 'jobName', 'result'],
  'bridge.crashed': ['bridgeName', 'crashCount']
}

export const notificationTemplateSchema = z.object({
  event: notificationTemplateEventSchema,
  /** Human-friendly label for the event, surfaced in the settings UI. */
  label: z.string(),
  /** Variables (without braces) that may appear in this template. */
  variables: z.array(z.string()),
  /** Whether the channel should deliver this event at all. */
  enabled: z.boolean(),
  /** User-edited or default title template (Mustache-style `{{var}}`). */
  title: z.string(),
  /** User-edited or default body template. */
  body: z.string(),
  /**
   * When true, the API tries to capture a chamber-camera snapshot at
   * dispatch time and attaches it to the outgoing notification. Only
   * effective for printer events on cameras the API can reach (P1/A1
   * series); silently skipped otherwise.
   */
  includeSnapshot: z.boolean(),
  /** Whether the printer model the event refers to supports snapshots. */
  snapshotSupported: z.boolean().optional(),
  /** True when the user has edited away from defaults. */
  customized: z.boolean(),
  defaults: z.object({
    enabled: z.boolean(),
    title: z.string(),
    body: z.string(),
    includeSnapshot: z.boolean()
  })
})
export type NotificationTemplate = z.infer<typeof notificationTemplateSchema>

export const notificationTemplateUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  title: z.string().max(500).optional(),
  body: z.string().max(2000).optional(),
  includeSnapshot: z.boolean().optional()
})
export type NotificationTemplateUpdate = z.infer<typeof notificationTemplateUpdateSchema>

export const notificationTemplateListSchema = z.object({
  templates: z.array(notificationTemplateSchema)
})
export type NotificationTemplateList = z.infer<typeof notificationTemplateListSchema>

export const notificationMessageSchema = z.object({
  /** Stable id so clients can dedupe across reconnects. */
  id: z.string(),
  category: notificationCategorySchema,
  level: notificationLevelSchema,
  title: z.string(),
  body: z.string(),
  /** ISO-8601 timestamp, set by the producer. */
  timestamp: z.string(),
  /** Optional printer the notification is about. */
  printerId: z.string().optional(),
  printerName: z.string().optional(),
  /**
   * Tenant that owns the printer/resource this notification is about.
   * Used by notification plugins to scope delivery to the correct
   * tenant's configuration (webhook URL, push subscriptions, etc.).
   */
  tenantId: z.string().optional(),
  /** Optional tag used by clients to group/replace notifications. */
  tag: z.string().optional(),
  /** Optional app route the browser should open when the user clicks the notification. */
  url: z.string().optional(),
  /**
   * Optional URL to a JPEG snapshot captured at the moment the
   * notification was emitted. Channels that support inline media
   * (Discord embeds, browser push, ntfy attachments) display this;
   * others ignore it. URL may be relative (`/api/...`) for same-origin
   * channels or absolute for external webhooks; the API populates
   * whichever form fits the configured `PUBLIC_BASE_URL`.
   */
  imageUrl: z.string().optional(),
  /**
   * When present, the message is addressed to specific users rather than
   * broadcast to a scope: channels that can address an individual (browser
   * push actor matching, account email, user-bound webhook recipients)
   * deliver only to these users, and shared broadcast destinations must NOT
   * receive it. With no `tenantId`, targeted delivery may span every scope
   * the user is registered in (platform-wide personal events).
   */
  targetUserIds: z.array(z.string()).optional(),
  /**
   * Set by emitters that already send their own transactional email for
   * this event (e.g. support messaging); the email channel skips the
   * message so recipients are not double-mailed.
   */
  emailHandledExternally: z.boolean().optional()
})
export type NotificationMessage = z.infer<typeof notificationMessageSchema>

/**
 * A platform-scope notification template (operator events, e.g. a bridge
 * crash or deployment-registered events). Unlike the printer-event templates
 * the event set is dynamic — deployments register their own definitions — so
 * `event` is an open string validated server-side against the registry.
 */
export const platformNotificationTemplateSchema = z.object({
  event: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  title: z.string(),
  body: z.string(),
  /** `{{variable}}` names available to this event's template. */
  variables: z.array(z.string()),
  /** True when a stored override exists (reset restores `defaults`). */
  customized: z.boolean(),
  defaults: z.object({
    enabled: z.boolean(),
    title: z.string(),
    body: z.string()
  })
})
export type PlatformNotificationTemplate = z.infer<typeof platformNotificationTemplateSchema>

export const platformNotificationTemplateListResponseSchema = z.object({
  templates: z.array(platformNotificationTemplateSchema)
})
export type PlatformNotificationTemplateListResponse = z.infer<typeof platformNotificationTemplateListResponseSchema>

export const platformNotificationTemplateUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().max(4000).optional()
}).refine(
  (value) => value.enabled !== undefined || value.title !== undefined || value.body !== undefined,
  'Expected at least one template field to update.'
)
export type PlatformNotificationTemplateUpdate = z.infer<typeof platformNotificationTemplateUpdateSchema>
