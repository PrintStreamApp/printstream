/**
 * Scope resolution for dual-surface notification channel plugins.
 *
 * A channel's configuration lives per tenant (`settings.forTenant`) inside a
 * workspace and in the plugin's base store at the platform scope, both for
 * HTTP routes (keyed by the request's tenant context) and for delivery
 * (keyed by the message's `tenantId`, which platform-scope messages omit).
 */
import type { Request } from 'express'
import { AUTHENTICATION_REQUIRED_MESSAGE } from './authorization.js'
import { unauthorized } from './http-error.js'
import type { ApiPluginContext, PluginSettingStore } from '../plugin/types.js'

export interface NotificationScope {
  /** Null at the platform scope. */
  tenantId: string | null
  settings: PluginSettingStore
}

/** The scope a channel route is operating in, from the request's tenant context. */
export function requestNotificationScope(context: ApiPluginContext, request: Request): NotificationScope {
  const tenantId = request.tenant?.id ?? null
  return {
    tenantId,
    settings: tenantId ? context.settings.forTenant(tenantId) : context.settings
  }
}

/** The scope a message delivers to, from the message's owning tenant. */
export function messageNotificationScope(context: ApiPluginContext, tenantId: string | null | undefined): NotificationScope {
  return {
    tenantId: tenantId ?? null,
    settings: tenantId ? context.settings.forTenant(tenantId) : context.settings
  }
}

/**
 * Per-user channel routes (opt-ins, device registrations) at the platform
 * scope are for platform users only — a workspace user has no business
 * subscribing to operator events.
 */
export function assertPlatformScopeActor(request: Request): void {
  if (request.auth.actor.type !== 'user' || !request.auth.actor.isPlatformUser) {
    throw unauthorized(AUTHENTICATION_REQUIRED_MESSAGE)
  }
}

/** The slice of the Prisma client the scope enumeration below needs. */
type SettingKeyReader = {
  setting: {
    findMany(args: { where: { key: { startsWith: string; endsWith: string } }; select: { key: true } }): Promise<Array<{ key: string }>>
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Enumerate the tenant ids that hold a value for one of a plugin's
 * per-tenant settings (stored under `plugin:<name>:tenant:<id>:<key>`).
 * Used by channels that must fan a platform-wide user-targeted message out
 * across every scope a user registered in — deliberately a cross-tenant
 * read, so callers should treat the result as scope ids only.
 */
export async function listTenantScopesWithPluginSetting(
  prisma: SettingKeyReader,
  pluginName: string,
  key: string
): Promise<string[]> {
  const rows = await prisma.setting.findMany({
    where: { key: { startsWith: `plugin:${pluginName}:tenant:`, endsWith: `:${key}` } },
    select: { key: true }
  })
  const pattern = new RegExp(`^plugin:${escapeRegExp(pluginName)}:tenant:([^:]+):${escapeRegExp(key)}$`)
  const tenantIds = new Set<string>()
  for (const row of rows) {
    const match = pattern.exec(row.key)
    if (match?.[1]) tenantIds.add(match[1])
  }
  return [...tenantIds]
}
