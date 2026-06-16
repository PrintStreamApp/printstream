/**
 * Editable notification templates.
 *
 * Notification plugins (ntfy, Discord, browser push, …) all derive
 * their title/body from a small set of printer-domain triggers. The
 * exact wording and which triggers are delivered should be tunable by
 * the user without touching code, so we keep a per-event template
 * (title, body, enabled) in the `Setting` table and render it at
 * dispatch time.
 *
 * State is global (shared across all channels). Per-channel overrides
 * are intentionally not supported in v1 — most users want one set of
 * messages everywhere; if that changes we can layer a per-plugin
 * override on top without breaking this contract.
 *
 * Storage key: `core:notifications:template:<event>` → JSON
 * `{ title, body, enabled }`. Missing fields fall back to the
 * built-in defaults below, so partial customisations stay valid even
 * if we add a new field later.
 */
import {
  notificationTemplateEventSchema,
  notificationTemplateVariables,
  type NotificationTemplate,
  type NotificationTemplateEvent,
  type NotificationTemplateUpdate
} from '@printstream/shared'
import type { Printer } from '@printstream/shared'
import { supportsChamberCamera } from './camera.js'
import { prisma } from './prisma.js'
import { getSettingScopePrefix, scopeSettingKey } from './tenant-settings.js'

interface TemplateBody {
  enabled: boolean
  title: string
  body: string
  includeSnapshot: boolean
}

interface TemplateDefinition {
  event: NotificationTemplateEvent
  label: string
  defaults: TemplateBody
}

const DEFINITIONS: TemplateDefinition[] = [
  {
    event: 'job.started',
    label: 'Print started',
    defaults: {
      enabled: false,
      title: '{{printerName}}: Print started',
      body: 'Job: {{jobName}}',
      includeSnapshot: false
    }
  },
  {
    event: 'job.paused',
    label: 'Print paused',
    defaults: {
      enabled: true,
      title: '{{printerName}}: Print paused',
      body: 'Job: {{jobName}}',
      includeSnapshot: true
    }
  },
  {
    event: 'job.error',
    label: 'Print error',
    defaults: {
      enabled: true,
      title: '{{printerName}}: Print error',
      body: 'Job: {{jobName}}\n{{errorMessage}}',
      includeSnapshot: true
    }
  },
  {
    event: 'job.finished.success',
    label: 'Print finished — success',
    defaults: {
      enabled: true,
      title: '{{printerName}}: Print finished',
      body: 'Job: {{jobName}}',
      includeSnapshot: true
    }
  },
  {
    event: 'job.finished.failed',
    label: 'Print finished — failed',
    defaults: {
      enabled: true,
      title: '{{printerName}}: Print failed',
      body: 'Job: {{jobName}}',
      includeSnapshot: true
    }
  },
  {
    event: 'job.finished.cancelled',
    label: 'Print finished — cancelled',
    defaults: {
      enabled: true,
      title: '{{printerName}}: Print cancelled',
      body: 'Job: {{jobName}}',
      includeSnapshot: false
    }
  }
]

const DEFINITION_BY_EVENT = new Map(DEFINITIONS.map((entry) => [entry.event, entry]))

const SETTING_PREFIX = 'core:notifications:template:'
const settingKey = (event: NotificationTemplateEvent) => scopeSettingKey(`${SETTING_PREFIX}${event}`)

/** In-memory cache so renderTemplate stays sync and cheap on the hot path. */
const cache = new Map<string, TemplateBody>()
const loadedScopes = new Set<string>()
const loadingByScope = new Map<string, Promise<void>>()

function parseStored(value: string): Partial<TemplateBody> | null {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    const out: Partial<TemplateBody> = {}
    if (typeof record.enabled === 'boolean') out.enabled = record.enabled
    if (typeof record.title === 'string') out.title = record.title
    if (typeof record.body === 'string') out.body = record.body
    if (typeof record.includeSnapshot === 'boolean') out.includeSnapshot = record.includeSnapshot
    return out
  } catch {
    return null
  }
}

function effectiveBody(event: NotificationTemplateEvent): TemplateBody {
  const definition = DEFINITION_BY_EVENT.get(event)!
  const stored = cache.get(cacheKey(event))
  return {
    enabled: stored?.enabled ?? definition.defaults.enabled,
    title: stored?.title ?? definition.defaults.title,
    body: stored?.body ?? definition.defaults.body,
    includeSnapshot: stored?.includeSnapshot ?? definition.defaults.includeSnapshot
  }
}

function isCustomized(event: NotificationTemplateEvent): boolean {
  const stored = cache.get(cacheKey(event))
  if (!stored) return false
  const defaults = DEFINITION_BY_EVENT.get(event)!.defaults
  return (
    (stored.enabled !== undefined && stored.enabled !== defaults.enabled) ||
    (stored.title !== undefined && stored.title !== defaults.title) ||
    (stored.body !== undefined && stored.body !== defaults.body) ||
    (stored.includeSnapshot !== undefined && stored.includeSnapshot !== defaults.includeSnapshot)
  )
}

function toView(event: NotificationTemplateEvent, printer?: Printer): NotificationTemplate {
  const definition = DEFINITION_BY_EVENT.get(event)!
  const effective = effectiveBody(event)
  return {
    event,
    label: definition.label,
    variables: [...notificationTemplateVariables[event]],
    enabled: effective.enabled,
    title: effective.title,
    body: effective.body,
    includeSnapshot: effective.includeSnapshot,
    snapshotSupported: printer ? supportsChamberCamera(printer.model) : undefined,
    customized: isCustomized(event),
    defaults: { ...definition.defaults }
  }
}

/**
 * Lazy-load every persisted template into the in-memory cache. Safe to
 * call repeatedly; the underlying read happens at most once.
 */
export async function loadNotificationTemplates(): Promise<void> {
  const scopePrefix = getSettingScopePrefix()
  if (loadedScopes.has(scopePrefix)) return
  const inflight = loadingByScope.get(scopePrefix)
  if (inflight) return inflight
  const scopedPrefix = scopeSettingKey(SETTING_PREFIX)
  const loading = (async () => {
    const rows = await prisma.setting.findMany({
      where: { key: { startsWith: scopedPrefix } }
    })
    for (const row of rows) {
      const event = row.key.slice(scopedPrefix.length)
      const parsedEvent = notificationTemplateEventSchema.safeParse(event)
      if (!parsedEvent.success) continue
      const body = parseStored(row.value)
      if (!body) continue
      const definition = DEFINITION_BY_EVENT.get(parsedEvent.data)!
      cache.set(cacheKey(parsedEvent.data), {
        enabled: body.enabled ?? definition.defaults.enabled,
        title: body.title ?? definition.defaults.title,
        body: body.body ?? definition.defaults.body,
        includeSnapshot: body.includeSnapshot ?? definition.defaults.includeSnapshot
      })
    }
    loadedScopes.add(scopePrefix)
    loadingByScope.delete(scopePrefix)
  })()
  loadingByScope.set(scopePrefix, loading)
  return loading
}

export function listNotificationTemplates(): NotificationTemplate[] {
  return DEFINITIONS.map((definition) => toView(definition.event))
}

export function getNotificationTemplate(event: NotificationTemplateEvent): NotificationTemplate {
  return toView(event)
}

export async function updateNotificationTemplate(
  event: NotificationTemplateEvent,
  update: NotificationTemplateUpdate
): Promise<NotificationTemplate> {
  const next: TemplateBody = {
    ...effectiveBody(event),
    ...update
  }
  cache.set(cacheKey(event), next)
  await prisma.setting.upsert({
    where: { key: settingKey(event) },
    create: { key: settingKey(event), value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) }
  })
  return toView(event)
}

export async function resetNotificationTemplate(
  event: NotificationTemplateEvent
): Promise<NotificationTemplate> {
  cache.delete(cacheKey(event))
  await prisma.setting.deleteMany({ where: { key: settingKey(event) } })
  return toView(event)
}

function cacheKey(event: NotificationTemplateEvent): string {
  return `${getSettingScopePrefix()}:${event}`
}

const TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g

function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(TOKEN_PATTERN, (match: string, name: string) => {
    return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] ?? match : match
  })
}

export interface RenderedTemplate {
  enabled: boolean
  includeSnapshot: boolean
  title: string
  body: string
}

/**
 * Render the (possibly user-edited) template for an event. Returns
 * `enabled: false` when the user has muted that event so callers can
 * suppress delivery entirely. Callers should pass every variable
 * declared in {@link notificationTemplateVariables} for the event;
 * missing keys leave the raw `{{token}}` so the issue is visible.
 */
export function renderNotificationTemplate(
  event: NotificationTemplateEvent,
  vars: Record<string, string>
): RenderedTemplate {
  const effective = effectiveBody(event)
  const title = substitute(effective.title, vars).trim()
  const rawBody = substitute(effective.body, vars).trim()
  // Some channels (ntfy, web push) require a non-empty body; if the
  // user's template renders empty (e.g. the only token is `{{jobName}}`
  // and we got no job name), fall back to the title so the message is
  // still useful.
  const body = rawBody.length > 0 ? rawBody : title
  return {
    enabled: effective.enabled,
    includeSnapshot: effective.includeSnapshot,
    title,
    body
  }
}

export function setNotificationTemplateOverrideForTests(
  event: NotificationTemplateEvent,
  update: Partial<{ enabled: boolean; title: string; body: string; includeSnapshot: boolean }> | null
): void {
  const key = cacheKey(event)
  if (!update) {
    cache.delete(key)
    return
  }
  const definition = DEFINITION_BY_EVENT.get(event)!
  cache.set(key, { ...definition.defaults, ...update })
}

export function resetNotificationTemplateCacheForTests(): void {
  cache.clear()
  loadedScopes.clear()
  loadingByScope.clear()
}
