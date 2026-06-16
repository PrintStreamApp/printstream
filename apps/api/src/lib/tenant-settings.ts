/**
 * Setting-key helpers that keep tenant-owned settings isolated while still
 * allowing platform-wide settings on the tenantless host.
 */
import { getCurrentTenant } from './tenant-context.js'

const PLATFORM_SCOPE_PREFIX = 'platform'

export function getSettingScopePrefixForTenant(tenantId?: string | null): string {
  if (!tenantId) {
    return PLATFORM_SCOPE_PREFIX
  }

  return `tenant:${tenantId}`
}

export function getSettingScopePrefix(): string {
  const tenant = getCurrentTenant()
  return getSettingScopePrefixForTenant(tenant?.id)
}

export function scopeSettingKey(key: string): string {
  return `${getSettingScopePrefix()}:${key}`
}

export function scopeSettingKeyForTenant(tenantId: string | null | undefined, key: string): string {
  return `${getSettingScopePrefixForTenant(tenantId)}:${key}`
}