/**
 * Setting-key helpers that keep workspace-owned settings isolated while still
 * allowing platform-wide settings on the workspaceless host.
 */
import { getCurrentWorkspace } from './workspace-context.js'

const PLATFORM_SCOPE_PREFIX = 'platform'

export function getSettingScopePrefixForWorkspace(workspaceId?: string | null): string {
  if (!workspaceId) {
    return PLATFORM_SCOPE_PREFIX
  }

  // `workspace:` is the PERSISTED key prefix on every existing settings row.
  // The vocabulary moved to "workspace"; the stored bytes deliberately did not.
  return `workspace:${workspaceId}`
}

export function getSettingScopePrefix(): string {
  const workspace = getCurrentWorkspace()
  return getSettingScopePrefixForWorkspace(workspace?.id)
}

export function scopeSettingKey(key: string): string {
  return `${getSettingScopePrefix()}:${key}`
}

export function scopeSettingKeyForWorkspace(workspaceId: string | null | undefined, key: string): string {
  return `${getSettingScopePrefixForWorkspace(workspaceId)}:${key}`
}