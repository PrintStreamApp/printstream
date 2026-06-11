import type { TenantSummary } from '@printstream/shared'

/**
 * Normalizes the access-scoped tenant workspace list returned by auth bootstrap
 * so the UI does not show duplicate workspace entries.
 */
export function listAccessibleTenantWorkspaces(tenants: ReadonlyArray<TenantSummary>): TenantSummary[] {
  const seenTenantIds = new Set<string>()
  const uniqueTenants: TenantSummary[] = []

  for (const tenant of tenants) {
    if (seenTenantIds.has(tenant.id)) {
      continue
    }

    seenTenantIds.add(tenant.id)
    uniqueTenants.push(tenant)
  }

  return uniqueTenants.sort((left, right) => {
    const nameComparison = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
    if (nameComparison !== 0) return nameComparison

    const slugComparison = left.slug.localeCompare(right.slug, undefined, { sensitivity: 'base' })
    if (slugComparison !== 0) return slugComparison

    return left.id.localeCompare(right.id)
  })
}

export function countAccessibleWorkspaceChoices(input: {
  tenants: ReadonlyArray<TenantSummary>
  includePlatform: boolean
}): number {
  return listAccessibleTenantWorkspaces(input.tenants).length + (input.includePlatform ? 1 : 0)
}

export function countSwitchableWorkspaceChoices(input: {
  tenants: ReadonlyArray<TenantSummary>
  includePlatform: boolean
  activeTenantId: string | null
}): number {
  const uniqueTenants = listAccessibleTenantWorkspaces(input.tenants)
  const tenantChoices = input.activeTenantId == null
    ? uniqueTenants.length
    : uniqueTenants.filter((tenant) => tenant.id !== input.activeTenantId).length
  const platformChoices = input.includePlatform && input.activeTenantId != null ? 1 : 0

  return tenantChoices + platformChoices
}