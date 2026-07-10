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
