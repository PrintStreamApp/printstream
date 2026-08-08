/**
 * Scope resolution for dual-surface notification channel plugins.
 *
 * A channel's configuration lives per workspace (`settings.forWorkspace`) inside a
 * workspace and in the plugin's base store at the platform scope, both for
 * HTTP routes (keyed by the request's workspace context) and for delivery
 * (keyed by the message's `workspaceId`, which platform-scope messages omit).
 */
import type { Request } from 'express'
import { AUTHENTICATION_REQUIRED_MESSAGE } from './authorization.js'
import { unauthorized } from './http-error.js'
import type { ApiPluginContext, PluginSettingStore } from '../plugin/types.js'

export interface NotificationScope {
  /** Null at the platform scope. */
  workspaceId: string | null
  settings: PluginSettingStore
}

/** The scope a channel route is operating in, from the request's workspace context. */
export function requestNotificationScope(context: ApiPluginContext, request: Request): NotificationScope {
  const workspaceId = request.workspace?.id ?? null
  return {
    workspaceId,
    settings: workspaceId ? context.settings.forWorkspace(workspaceId) : context.settings
  }
}

/** The scope a message delivers to, from the message's owning workspace. */
export function messageNotificationScope(context: ApiPluginContext, workspaceId: string | null | undefined): NotificationScope {
  return {
    workspaceId: workspaceId ?? null,
    settings: workspaceId ? context.settings.forWorkspace(workspaceId) : context.settings
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
 * Enumerate the workspace ids that hold a value for one of a plugin's
 * per-workspace settings (stored under `plugin:<name>:workspace:<id>:<key>`).
 * Used by channels that must fan a platform-wide user-targeted message out
 * across every scope a user registered in — deliberately a cross-workspace
 * read, so callers should treat the result as scope ids only.
 */
export async function listWorkspaceScopesWithPluginSetting(
  prisma: SettingKeyReader,
  pluginName: string,
  key: string
): Promise<string[]> {
  const rows = await prisma.setting.findMany({
    where: { key: { startsWith: `plugin:${pluginName}:workspace:`, endsWith: `:${key}` } },
    select: { key: true }
  })
  const pattern = new RegExp(`^plugin:${escapeRegExp(pluginName)}:workspace:([^:]+):${escapeRegExp(key)}$`)
  const workspaceIds = new Set<string>()
  for (const row of rows) {
    const match = pattern.exec(row.key)
    if (match?.[1]) workspaceIds.add(match[1])
  }
  return [...workspaceIds]
}
