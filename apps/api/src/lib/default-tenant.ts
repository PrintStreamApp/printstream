/**
 * Shared tenant-list helpers for platform bootstrap flows, plus the wide-open
 * fallback workspace used by fresh self-hosted installs.
 */
import { authProviderRegistry } from './auth-registry.js'
import type { AnyPrismaClient } from './prisma.js'
import { rootPrisma } from './prisma.js'
import { isPublicDemoTenant } from './public-demo-policy.js'
import { isTenantDisabled } from './tenant-availability.js'
import type { RequestTenantSummary } from './tenant-context.js'
import { withTenantRequestContext } from './tenant-context.js'

export async function listTenants(prisma: AnyPrismaClient): Promise<Array<{
  id: string
  slug: string
  name: string
  description?: string | null
}>> {
  return await prisma.tenant.findMany({
    orderBy: [
      { name: 'asc' },
      { createdAt: 'asc' }
    ],
    select: {
      id: true,
      slug: true,
      name: true,
      description: true
    }
  })
}

interface SoleTenantDeps {
  listCandidateTenants?: () => Promise<RequestTenantSummary[]>
  isTenantDisabled?: (tenantId: string) => Promise<boolean>
  isPublicDemoTenant?: (tenant: RequestTenantSummary) => boolean
}

/**
 * Resolves the single enabled, non-demo workspace on this install, or `null`
 * when the choice is ambiguous (zero or more than one surviving candidate).
 * This is the "exactly one real workspace" test shared by the wide-open
 * default-tenant fallback and managed-bridge auto-pairing; it deliberately
 * makes no auth-provider judgement so callers can layer their own policy on
 * top (wide-open requires no enabled provider; managed-bridge does not).
 */
export async function resolveSoleTenant(deps: SoleTenantDeps = {}): Promise<RequestTenantSummary | null> {
  const listCandidateTenants = deps.listCandidateTenants
    ?? (async () => await rootPrisma.tenant.findMany({
      // A handful is plenty: a second surviving candidate already makes the
      // choice ambiguous and aborts the fallback.
      take: 5,
      orderBy: { createdAt: 'asc' },
      select: { id: true, slug: true, name: true }
    }))
  const tenantIsDisabled = deps.isTenantDisabled
    ?? (async (tenantId: string) => await isTenantDisabled({ tenantId }))
  const tenantIsPublicDemo = deps.isPublicDemoTenant ?? isPublicDemoTenant

  const candidates: RequestTenantSummary[] = []
  for (const tenant of await listCandidateTenants()) {
    if (tenantIsPublicDemo(tenant)) continue
    if (await tenantIsDisabled(tenant.id)) continue
    candidates.push(tenant)
    if (candidates.length > 1) return null
  }
  return candidates[0] ?? null
}

interface WideOpenDefaultTenantDeps extends SoleTenantDeps {
  hasAnyEnabledProvider?: (tenant: RequestTenantSummary | null) => Promise<boolean>
}

/**
 * Resolves the workspace that context-less requests should default into on a
 * deployment that runs "wide open" (no auth provider enabled anywhere — the
 * documented fresh self-hosted install state, in which nobody can be signed
 * in). Returns the workspace only when the choice is unambiguous: exactly one
 * enabled, non-demo workspace, with no enabled auth provider in either the
 * platform scope or that workspace's scope. A provider that is enabled but
 * still awaiting setup also blocks the fallback — that install is mid-setup,
 * not wide open.
 */
export async function resolveWideOpenDefaultTenant(deps: WideOpenDefaultTenantDeps = {}): Promise<RequestTenantSummary | null> {
  const hasAnyEnabledProvider = deps.hasAnyEnabledProvider
    ?? (async (tenant: RequestTenantSummary | null) =>
      (await withTenantRequestContext(tenant, async () => await authProviderRegistry.list()))
        .some((provider) => provider.enabled))
  if (await hasAnyEnabledProvider(null)) {
    return null
  }

  const tenant = await resolveSoleTenant(deps)
  if (!tenant) {
    return null
  }

  return (await hasAnyEnabledProvider(tenant)) ? null : tenant
}
