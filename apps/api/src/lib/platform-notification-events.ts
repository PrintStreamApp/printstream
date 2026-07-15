/**
 * Platform-scope notification events: operator-level triggers with editable
 * templates, delivered through the same channel plugins as printer
 * notifications but at the platform (tenantless) scope.
 *
 * Event definitions are registered at startup (`registerPlatformNotificationEvents`)
 * so deployments can differ: the private cloud module registers its operator
 * events (beta signups, new workspaces); an OSS install registers none and the
 * platform templates surface stays empty. Templates are stored under the
 * platform settings scope (`platform:notifications:template:<event>`), and
 * `emitPlatformNotification` renders + fans the message out over the
 * `platform.notification` bus event that `subscribePrinterNotifications`
 * forwards to every channel handler.
 */
import { randomUUID } from 'node:crypto'
import type { NotificationMessage, PlatformNotificationTemplate } from '@printstream/shared'
import { printerEvents } from './printer-events.js'
import { prisma } from './prisma.js'
import { scopeSettingKeyForTenant } from './tenant-settings.js'

export interface PlatformNotificationEventDefinition {
  /** Stable event id (kebab-case), unique across the deployment. */
  event: string
  label: string
  variables: string[]
  defaults: {
    enabled: boolean
    title: string
    body: string
  }
}

const definitions = new Map<string, PlatformNotificationEventDefinition>()

/**
 * Register platform events (idempotent per event id; later registrations
 * replace earlier ones). Call at startup — core or private modules.
 */
export function registerPlatformNotificationEvents(entries: PlatformNotificationEventDefinition[]): void {
  for (const entry of entries) {
    definitions.set(entry.event, entry)
  }
}

export function isKnownPlatformNotificationEvent(event: string): boolean {
  return definitions.has(event)
}

function templateSettingKey(event: string): string {
  return scopeSettingKeyForTenant(null, `notifications:platform-template:${event}`)
}

interface StoredTemplate {
  enabled?: boolean
  title?: string
  body?: string
}

async function readStoredTemplate(event: string): Promise<StoredTemplate | null> {
  const row = await prisma.setting.findUnique({ where: { key: templateSettingKey(event) } })
  if (!row) return null
  try {
    const parsed = JSON.parse(row.value)
    return parsed && typeof parsed === 'object' ? (parsed as StoredTemplate) : null
  } catch {
    // Corrupt row: fall back to defaults rather than failing delivery.
    return null
  }
}

export async function getPlatformNotificationTemplate(event: string): Promise<PlatformNotificationTemplate> {
  const definition = definitions.get(event)
  if (!definition) throw new Error(`Unknown platform notification event: ${event}`)

  const stored = await readStoredTemplate(event)
  return {
    event,
    label: definition.label,
    variables: definition.variables,
    enabled: typeof stored?.enabled === 'boolean' ? stored.enabled : definition.defaults.enabled,
    title: typeof stored?.title === 'string' ? stored.title : definition.defaults.title,
    body: typeof stored?.body === 'string' ? stored.body : definition.defaults.body,
    customized: stored != null,
    defaults: { ...definition.defaults }
  }
}

export async function listPlatformNotificationTemplates(): Promise<PlatformNotificationTemplate[]> {
  return await Promise.all([...definitions.keys()].map((event) => getPlatformNotificationTemplate(event)))
}

export async function updatePlatformNotificationTemplate(
  event: string,
  update: { enabled?: boolean; title?: string; body?: string }
): Promise<PlatformNotificationTemplate> {
  const current = await getPlatformNotificationTemplate(event)
  const next: Required<StoredTemplate> = {
    enabled: update.enabled ?? current.enabled,
    title: update.title ?? current.title,
    body: update.body ?? current.body
  }
  const key = templateSettingKey(event)
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) }
  })
  return await getPlatformNotificationTemplate(event)
}

/** Drop the stored override so the template reverts to its defaults. */
export async function resetPlatformNotificationTemplate(event: string): Promise<PlatformNotificationTemplate> {
  if (!definitions.has(event)) throw new Error(`Unknown platform notification event: ${event}`)
  await prisma.setting.deleteMany({ where: { key: templateSettingKey(event) } })
  return await getPlatformNotificationTemplate(event)
}

/** Substitute `{{variable}}` placeholders; unknown variables render empty. */
export function renderPlatformNotificationTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, name: string) => variables[name] ?? '')
}

export interface PlatformNotificationEmitOptions {
  /**
   * Address the rendered message to specific platform users instead of
   * broadcasting to every platform-scope channel destination (e.g. a claimed
   * support conversation notifies only its assignee). Channel semantics
   * follow the shared `targetUserIds` contract.
   */
  targetUserIds?: string[]
  /** The emitter already sends its own transactional email for this event. */
  emailHandledExternally?: boolean
  level?: NotificationMessage['level']
  /** App route to open when the notification is clicked. */
  url?: string
}

/**
 * Render + fan out a platform event to every notification channel's
 * platform-scope delivery. Fire-and-forget: unknown/disabled events and
 * failures log instead of throwing so calling routes never depend on
 * notification delivery.
 */
export async function emitPlatformNotification(
  event: string,
  variables: Record<string, string>,
  options: PlatformNotificationEmitOptions = {}
): Promise<void> {
  try {
    if (!definitions.has(event)) {
      console.warn('[platform-notifications] unregistered event dropped', { event })
      return
    }
    const template = await getPlatformNotificationTemplate(event)
    if (!template.enabled) return

    const message: NotificationMessage = {
      id: randomUUID(),
      category: 'system',
      level: options.level ?? 'info',
      title: renderPlatformNotificationTemplate(template.title, variables),
      body: renderPlatformNotificationTemplate(template.body, variables),
      timestamp: new Date().toISOString(),
      tag: `platform:${event}`,
      url: options.url,
      targetUserIds: options.targetUserIds,
      emailHandledExternally: options.emailHandledExternally
    }
    printerEvents.emit('platform.notification', { message })
  } catch (error) {
    console.warn('[platform-notifications] failed to emit event', {
      event,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/**
 * Fan a fully-formed user-targeted message out over the same
 * `platform.notification` bus event. For emitters outside the template
 * registry whose copy is transactional rather than operator-editable
 * (support replies to a user, suggestion-comment notifications). The
 * message must carry `targetUserIds`; tenantless messages deliver
 * cross-scope per the shared targeted contract. Fire-and-forget.
 */
export function emitUserNotification(
  message: Omit<NotificationMessage, 'id' | 'timestamp'> & { targetUserIds: string[] }
): void {
  try {
    if (message.targetUserIds.length === 0) return
    printerEvents.emit('platform.notification', {
      message: { ...message, id: randomUUID(), timestamp: new Date().toISOString() }
    })
  } catch (error) {
    console.warn('[platform-notifications] failed to emit user notification', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
