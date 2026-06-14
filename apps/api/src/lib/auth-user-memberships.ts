/**
 * Tenant-aware auth-user query helpers.
 *
 * Auth users are global identities. Tenant-specific sign-in state and
 * workspace access now live on `AuthTenantMembership`, while role grants stay
 * on tenant-scoped auth groups.
 */
import { Prisma, type AuthUser } from '@prisma/client'
import type { AuthGroupSummary } from '@printstream/shared'
import { getCurrentTenant, type RequestTenantSummary } from './tenant-context.js'

export const NEVER_MATCH_TENANT_ID = '__never_match_tenant__'

const tenantSummarySelect = {
  id: true,
  slug: true,
  name: true
} as const

export function buildScopedAuthUserInclude(tenantId: string | null = getCurrentTenant()?.id ?? null) {
  const groupTenantFilter = tenantId !== null ? { tenantId } : { tenantId: null as string | null }
  const tenantMembershipFilter = tenantId !== null ? { tenantId } : { tenantId: NEVER_MATCH_TENANT_ID }
  return {
    tenantMemberships: {
      where: tenantMembershipFilter,
      select: {
        loginDisabled: true,
        tenant: {
          select: tenantSummarySelect
        }
      }
    },
    memberships: {
      where: {
        group: groupTenantFilter
      },
      select: {
        group: {
          select: {
            id: true,
            key: true,
            name: true,
            permissions: true
          }
        }
      }
    },
    _count: {
      select: {
        passkeys: true
      }
    }
  } as const
}

export type ScopedAuthUserRow = Prisma.AuthUserGetPayload<{
  include: ReturnType<typeof buildScopedAuthUserInclude>
}>

export type AuthUserTenantMembershipRow = ScopedAuthUserRow['tenantMemberships'][number]

export function buildManageableAuthUserWhere(id?: string, tenantId = getCurrentTenant()?.id ?? null): Prisma.AuthUserWhereInput {
  if (tenantId) {
    return {
      ...(id ? { id } : {}),
      tenantMemberships: {
        some: {
          tenantId
        }
      }
    }
  }

  return {
    ...(id ? { id } : {}),
    isPlatformUser: true
  }
}

export function buildCurrentAuthUserWhere(id: string, tenantId = getCurrentTenant()?.id ?? null): Prisma.AuthUserWhereInput {
  if (tenantId) {
    return {
      id,
      tenantMemberships: {
        some: {
          tenantId
        }
      }
    }
  }

  return { id }
}

export function readScopedAuthUserLoginDisabled(user: { tenantMemberships?: Array<{ loginDisabled: boolean }> }): boolean {
  return user.tenantMemberships?.[0]?.loginDisabled ?? false
}

export function readScopedAuthUserTenant(user: { tenantMemberships?: Array<{ tenant: RequestTenantSummary }> }): RequestTenantSummary | null {
  const tenant = user.tenantMemberships?.[0]?.tenant
  return tenant ?? null
}

export function buildTenantMembershipWhere(tenantId: string): Prisma.AuthTenantMembershipWhereInput {
  return { tenantId }
}

export function buildEnabledTenantMembershipWhere(tenantId: string): Prisma.AuthTenantMembershipWhereInput {
  return {
    tenantId,
    loginDisabled: false
  }
}

export function buildAuthUserEmailUpdateData(input: {
  email?: string
  displayName?: string | null
}): Pick<AuthUser, 'email' | 'displayName'> | { email?: string; displayName?: string | null } {
  return {
    email: input.email !== undefined ? input.email.trim().toLowerCase() : undefined,
    displayName: input.displayName !== undefined ? input.displayName?.trim() || null : undefined
  }
}

export function toAuthUserDto(row: ScopedAuthUserRow, options: { canManage?: boolean } = {}) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    loginDisabled: readScopedAuthUserLoginDisabled(row),
    isPlatformUser: row.isPlatformUser,
    ...(options.canManage === undefined ? {} : { canManage: options.canManage }),
    groups: toSortedGroupSummaries(row.memberships.map((membership) => membership.group)),
    passkeyCount: row._count.passkeys,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

const BUILT_IN_GROUP_ORDER: Record<string, number> = {
  admin: 0,
  platform_manager: 1,
  platform_support: 2,
  technician: 4,
  operator: 5,
  viewer: 6
}

export function toSortedGroupSummaries(groups: Array<{ id: string; key: string | null; name: string }>): AuthGroupSummary[] {
  return [...groups]
    .sort((left, right) => {
      const leftRank = left.key ? (BUILT_IN_GROUP_ORDER[left.key] ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
      const rightRank = right.key ? (BUILT_IN_GROUP_ORDER[right.key] ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
      if (leftRank !== rightRank) return leftRank - rightRank
      return left.name.localeCompare(right.name)
    })
    .map((group) => ({
      id: group.id,
      key: group.key,
      name: group.name
    }))
}