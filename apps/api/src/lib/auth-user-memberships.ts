/**
 * Workspace-aware auth-user query helpers.
 *
 * Auth users are global identities. Workspace-specific sign-in state and
 * workspace access now live on `AuthWorkspaceMembership`, while role grants stay
 * on workspace-scoped auth groups.
 */
import { Prisma, type AuthUser } from '@prisma/client'
import type { AuthGroupSummary } from '@printstream/shared'
import { permissionsAreManageableByActor } from './auth-capabilities.js'
import type { RequestAuthContext } from './auth-context.js'
import { conflict, forbidden } from './http-error.js'
import { prisma } from './prisma.js'
import { getCurrentWorkspace } from './workspace-context.js'

export const NEVER_MATCH_WORKSPACE_ID = '__never_match_workspace__'

const workspaceSummarySelect = {
  id: true,
  slug: true,
  name: true
} as const

export function buildScopedAuthUserInclude(workspaceId: string | null = getCurrentWorkspace()?.id ?? null) {
  const groupWorkspaceFilter = workspaceId !== null ? { workspaceId } : { workspaceId: null as string | null }
  const workspaceMembershipFilter = workspaceId !== null ? { workspaceId } : { workspaceId: NEVER_MATCH_WORKSPACE_ID }
  return {
    workspaceMemberships: {
      where: workspaceMembershipFilter,
      select: {
        loginDisabled: true,
        workspace: {
          select: workspaceSummarySelect
        }
      }
    },
    memberships: {
      where: {
        group: groupWorkspaceFilter
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

export function buildManageableAuthUserWhere(id?: string, workspaceId = getCurrentWorkspace()?.id ?? null): Prisma.AuthUserWhereInput {
  if (workspaceId) {
    return {
      ...(id ? { id } : {}),
      workspaceMemberships: {
        some: {
          workspaceId
        }
      }
    }
  }

  return {
    ...(id ? { id } : {}),
    isPlatformUser: true
  }
}

export function buildCurrentAuthUserWhere(id: string, workspaceId = getCurrentWorkspace()?.id ?? null): Prisma.AuthUserWhereInput {
  if (workspaceId) {
    return {
      id,
      workspaceMemberships: {
        some: {
          workspaceId
        }
      }
    }
  }

  return { id }
}

export function readScopedAuthUserLoginDisabled(user: { workspaceMemberships?: Array<{ loginDisabled: boolean }> }): boolean {
  return user.workspaceMemberships?.[0]?.loginDisabled ?? false
}

/** Effective permissions a scoped auth user holds via its (workspace-scoped) groups. */
export function readScopedAuthUserGrantedPermissions(user: ScopedAuthUserRow): string[] {
  return Array.from(new Set(user.memberships.flatMap((membership) => membership.group.permissions)))
}

/**
 * Whether the requesting actor may manage this user under the management-hierarchy
 * rule: the actor must hold every permission the target user has. Delegates to
 * `permissionsAreManageableByActor`, which short-circuits to `true` when auth is
 * not using explicit permissions (auth disabled).
 */
export function canManageScopedAuthUser(auth: RequestAuthContext, user: ScopedAuthUserRow): boolean {
  return permissionsAreManageableByActor(auth, readScopedAuthUserGrantedPermissions(user))
}

/**
 * Throws 403 when the actor may not manage the target user. Use in provider
 * plugins (passkeys, invites) so they enforce the same hierarchy as the core
 * auth-management routes rather than only a coarse per-action permission.
 */
export function assertCanManageScopedAuthUser(auth: RequestAuthContext, user: ScopedAuthUserRow): void {
  if (canManageScopedAuthUser(auth, user)) return
  throw forbidden('You cannot manage a user with permissions you do not have.')
}

export function buildEnabledWorkspaceMembershipWhere(workspaceId: string): Prisma.AuthWorkspaceMembershipWhereInput {
  return {
    workspaceId,
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

/**
 * Persists a managed auth-user create as a single transaction and returns the
 * created/reused user id.
 *
 * Mirrors the one-account model: with no workspace context the row is a platform
 * user (created or promoted, never duplicated); with workspace context it adds (or
 * requires the absence of) an `AuthWorkspaceMembership`. Workspace-local group grants
 * are attached in the same transaction. Callers own validation, permission
 * checks, audit logging, hydration, and unique-constraint handling.
 */
export async function createManagedAuthUser(input: {
  workspaceId: string | null
  email: string
  displayName: string | null
  groupIds: string[]
}): Promise<string> {
  const { workspaceId, email, displayName, groupIds } = input
  return prisma.$transaction(async (tx) => {
    if (!workspaceId) {
      const existingUser = await tx.authUser.findFirst({
        where: {
          email: {
            equals: email,
            mode: 'insensitive'
          }
        },
        select: {
          id: true,
          isPlatformUser: true
        }
      })

      if (existingUser?.isPlatformUser) {
        throw conflict('An auth user with that email already exists.')
      }

      const userId = existingUser
        ? (await tx.authUser.update({
            where: { id: existingUser.id },
            data: { isPlatformUser: true },
            select: { id: true }
          })).id
        : (await tx.authUser.create({
            data: {
              email,
              displayName,
              isPlatformUser: true
            }
          })).id

      if (groupIds.length > 0) {
        await tx.authUserGroupMembership.createMany({
          data: groupIds.map((groupId) => ({
            userId,
            groupId
          }))
        })
      }
      return userId
    }

    const existingUser = await tx.authUser.findFirst({
      where: {
        email: {
          equals: email,
          mode: 'insensitive'
        }
      },
      select: {
        id: true
      }
    })

    const userId = existingUser
      ? existingUser.id
      : (await tx.authUser.create({
          data: {
            email,
            displayName
          }
        })).id

    const existingMembership = await tx.authWorkspaceMembership.findUnique({
      where: {
        userId_workspaceId: {
          userId,
          workspaceId
        }
      },
      select: {
        userId: true
      }
    })

    if (existingMembership) {
      throw conflict('An auth user with that email already exists in this workspace.')
    }

    await tx.authWorkspaceMembership.create({
      data: {
        userId,
        workspaceId
      }
    })

    if (groupIds.length > 0) {
      await tx.authUserGroupMembership.createMany({
        data: groupIds.map((groupId) => ({
          userId,
          groupId
        }))
      })
    }

    return userId
  })
}

/**
 * Removes a managed auth user as a single transaction.
 *
 * With no workspace context this deletes the global `AuthUser` outright. With
 * workspace context it removes only that workspace's group memberships and workspace
 * membership, then deletes the global user only once it is not a platform user
 * and has no remaining workspace memberships. Reads the active workspace at call time
 * to match the caller's request context. Callers own permission checks,
 * lockout guards, audit logging, and the post-delete broadcast.
 */
export async function deleteManagedAuthUser(userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const workspaceId = getCurrentWorkspace()?.id ?? null
    if (!workspaceId) {
      await tx.authUser.delete({ where: { id: userId } })
      return
    }

    await tx.authUserGroupMembership.deleteMany({
      where: {
        userId,
        group: {
          workspaceId
        }
      }
    })

    await tx.authWorkspaceMembership.delete({
      where: {
        userId_workspaceId: {
          userId,
          workspaceId
        }
      }
    })

    const remainingUser = await tx.authUser.findUnique({
      where: { id: userId },
      select: {
        isPlatformUser: true,
        _count: {
          select: {
            workspaceMemberships: true
          }
        }
      }
    })

    if (remainingUser && !remainingUser.isPlatformUser && remainingUser._count.workspaceMemberships === 0) {
      await tx.authUser.delete({ where: { id: userId } })
    }
  })
}