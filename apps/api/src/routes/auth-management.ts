/**
 * Core auth management routes, provider-independent (they operate on identities,
 * roles, and sessions, not on how a user authenticates). Route families:
 * - `/me` — the current user's own profile (self-service, no manage permission).
 * - `/groups`, `/status` — roles/permission groups (view/create/edit/delete gated
 *   by the matching `AUTH_ROLES_*` permission).
 * - `/users` — create/edit/delete users, assign roles, and view/revoke their
 *   sessions (each gated by the matching `AUTH_USERS_*` permission).
 * - `/service-accounts` — issue/edit/revoke non-human API identities.
 * - `/session-policy` — deployment-wide session lifetime/idle policy.
 *
 * Two security invariants cut across the mutating routes:
 * - Privilege ceiling: an actor may not create, edit, or assign a user,
 *   service account, or role whose permission set exceeds their own (the
 *   `CANNOT_MANAGE_HIGHER_*` / `CANNOT_ASSIGN_HIGHER_ROLE` guards), so no one can
 *   escalate privileges through management.
 * - Self-protection: an actor cannot disable or delete the account they are
 *   currently signed in as, which would lock them (and possibly the last admin)
 *   out mid-request.
 */
import crypto from 'node:crypto'
import {
  AUTH_ACCESS_VIEW_PERMISSION,
  AUTH_ROLES_ASSIGN_PERMISSION,
  AUTH_ROLES_CREATE_PERMISSION,
  AUTH_ROLES_DELETE_PERMISSION,
  AUTH_ROLES_EDIT_PERMISSION,
  AUTH_ROLES_VIEW_PERMISSION,
  AUTH_SERVICE_ACCOUNTS_ASSIGN_ROLES_PERMISSION,
  AUTH_SERVICE_ACCOUNTS_CREATE_PERMISSION,
  AUTH_SERVICE_ACCOUNTS_EDIT_PERMISSION,
  AUTH_SERVICE_ACCOUNTS_REVOKE_PERMISSION,
  AUTH_SERVICE_ACCOUNTS_VIEW_PERMISSION,
  AUTH_SESSION_POLICY_MANAGE_PERMISSION,
  AUTH_USERS_ASSIGN_ROLES_PERMISSION,
  AUTH_USERS_CREATE_PERMISSION,
  AUTH_USERS_DELETE_PERMISSION,
  AUTH_USERS_DISABLE_SIGN_IN_PERMISSION,
  AUTH_USERS_REVOKE_SESSIONS_PERMISSION,
  AUTH_USERS_VIEW_PERMISSION,
  AUTH_USERS_VIEW_SESSIONS_PERMISSION,
  authGroupListResponseSchema,
  authManagementStatusSchema,
  authGroupSchema,
  authSessionListResponseSchema,
  authSessionPolicySchema,
  authServiceAccountListResponseSchema,
  authServiceAccountSchema,
  authUserListResponseSchema,
  authUserResponseSchema,
  createAuthGroupRequestSchema,
  createAuthServiceAccountRequestSchema,
  createAuthServiceAccountResponseSchema,
  createManagedAuthUserRequestSchema,
  updateAuthGroupRequestSchema,
  updateAuthServiceAccountRequestSchema,
  updateAuthSessionPolicyRequestSchema,
  updateAuthUserGroupsRequestSchema,
  updateAuthUserRequestSchema,
  updateCurrentAuthUserRequestSchema,
  isPermissionVisibleInPlatformContext,
  isPermissionVisibleInWorkspaceContext,
  resolveImpliedPermissions,
  type Permission
} from '@printstream/shared'
import { Prisma } from '@prisma/client'
import { Router, type Request } from 'express'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { permissionsAreManageableByActor } from '../lib/auth-capabilities.js'
import { buildAuthManagementStatus } from '../lib/auth-management-status.js'
import { broadcastAuthChangedForUsers } from '../lib/auth-change-events.js'
import { ensureBuiltInAuthGroups, ensureBuiltInPlatformAuthGroups } from '../lib/default-auth-groups.js'
import { readAuthSessionDuration, writeAuthSessionDuration } from '../lib/auth-policy.js'
import {
  buildAuthUserEmailUpdateData,
  buildCurrentAuthUserWhere,
  buildEnabledWorkspaceMembershipWhere,
  buildManageableAuthUserWhere,
  buildScopedAuthUserInclude,
  createManagedAuthUser,
  deleteManagedAuthUser,
  readScopedAuthUserLoginDisabled,
  toAuthUserDto,
  toSortedGroupSummaries,
  type ScopedAuthUserRow,
  NEVER_MATCH_WORKSPACE_ID
} from '../lib/auth-user-memberships.js'
import { requireRouteParam } from '../lib/request-helpers.js'
import { hashServiceAccountToken, readRequestAuthSessionSecretHash, requireRecentUserSession } from '../lib/auth-session.js'
import { assertAuthMutationsAllowed } from '../lib/demo-mode.js'
import { getCurrentWorkspace } from '../lib/workspace-context.js'
import { protectedWorkspaceMemberReason } from '../lib/workspace-owner-guard.js'
import { AUTHENTICATION_REQUIRED_MESSAGE, assertRequestPermission, requireAuthenticatedCurrentUser, requireAuthenticatedRequestPermission, requireRequestPermission } from '../lib/authorization.js'
import { assertWorkspaceMayAddPerson, joinWorkspaceOrganisation, listOrganisationCandidates } from '../lib/workspace-invite-policy.js'
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/http-error.js'
import { prisma } from '../lib/prisma.js'
import { isUniqueConstraintError } from '../lib/prisma-errors.js'

type GroupSummaryRow = {
  id: string
  key: string | null
  name: string
  permissions: string[]
}

type AuthGroupWithCounts = {
  id: string
  key: string | null
  name: string
  description: string | null
  permissions: string[]
  isSystem: boolean
  isEditable: boolean
  isRemovable: boolean
  createdAt: Date
  updatedAt: Date
  _count: {
    userMemberships: number
    serviceAccountMemberships: number
  }
}

type AuthUserRow = ScopedAuthUserRow

type AuthSessionRow = {
  id: string
  secretHash: string
  userAgent: string | null
  createdAt: Date
  lastSeenAt: Date | null
  expiresAt: Date
}

type AuthServiceAccountRow = {
  id: string
  name: string
  tokenPrefix: string
  lastUsedAt: Date | null
  revokedAt: Date | null
  createdAt: Date
  updatedAt: Date
  memberships: Array<{ group: GroupSummaryRow }>
}

const ADMIN_GROUP_KEY = 'admin'
const CANNOT_MANAGE_HIGHER_USER_MESSAGE = 'You cannot manage a user with permissions you do not have.'
const CANNOT_MANAGE_HIGHER_SERVICE_ACCOUNT_MESSAGE = 'You cannot manage a service account with permissions you do not have.'
const CANNOT_ASSIGN_HIGHER_ROLE_MESSAGE = 'You cannot assign roles with permissions you do not have.'
const authServiceAccountInclude = {
  memberships: {
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
  }
} as const

export const authManagementRouter = Router()

authManagementRouter.use((request, _response, next) => {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
    next()
    return
  }

  try {
    assertAuthMutationsAllowed(request)
    next()
  } catch (error) {
    next(error)
  }
})

authManagementRouter.get('/me', requireAuthenticatedCurrentUser(), async (request, response) => {
  const user = await requireCurrentAuthUser(request)
  response.json(authUserResponseSchema.parse({
    user: toAuthUserDto(user)
  }))
})

authManagementRouter.patch('/me', requireAuthenticatedCurrentUser(), async (request, response) => {
  const parsed = updateCurrentAuthUserRequestSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest('Invalid auth user payload.')

  const existing = await requireCurrentAuthUser(request)
  const nextEmail = parsed.data.email?.trim().toLowerCase()

  if (nextEmail && nextEmail !== existing.email) {
    throw conflict('Verify the new email address before changing it.')
  }

  try {
    await prisma.authUser.update({
      where: { id: existing.id },
      data: buildAuthUserEmailUpdateData(parsed.data)
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflict('An auth user with that email already exists.')
    }
    throw error
  }

  const updated = await prisma.authUser.findUnique({
    where: { id: existing.id },
    include: buildScopedAuthUserInclude()
  })
  if (!updated) throw notFound('Auth user not found.')

  annotateRequestAuditLog(request, {
    action: 'update-account-profile',
    resource: 'account profile',
    summary: 'Updated the current account profile.',
    metadata: {
      userId: updated.id
    }
  })

  response.json(authUserResponseSchema.parse({
    user: toAuthUserDto(updated)
  }))
})

authManagementRouter.get('/groups', requireRequestPermission(AUTH_ROLES_VIEW_PERMISSION), async (_request, response) => {
  await ensureScopedBuiltInAuthGroups()
  const rows = await prisma.authGroup.findMany({
    where: buildScopedAuthGroupWhere(),
    orderBy: { name: 'asc' },
    include: {
      _count: {
        select: {
          userMemberships: true,
          serviceAccountMemberships: true
        }
      }
    }
  })
  response.json(authGroupListResponseSchema.parse({
    groups: rows.map((row) => toAuthGroupDto(_request, row))
  }))
})

authManagementRouter.get('/status', requireRequestPermission(AUTH_ACCESS_VIEW_PERMISSION), async (_request, response) => {
  await ensureScopedBuiltInAuthGroups()
  response.json(authManagementStatusSchema.parse(await buildAuthManagementStatus(prisma, _request.auth)))
})

authManagementRouter.post('/groups', requireRequestPermission(AUTH_ROLES_CREATE_PERMISSION), async (request, response) => {
  const parsed = createAuthGroupRequestSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest('Invalid auth group payload.')
  await requireRecentAuthManagementVerification(request)
  const workspaceId = getCurrentWorkspace()?.id ?? null
  const permissions = expandWithImpliedPermissions(parsed.data.permissions)
  assertContextVisiblePermissions(permissions)
  assertRequestPermission(request, AUTH_ROLES_ASSIGN_PERMISSION)
  assertCanAssignPermissions(request, permissions)

  const created = await prisma.authGroup.create({
    data: {
      workspaceId,
      key: null,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      permissions,
      isSystem: false,
      isEditable: true,
      isRemovable: true
    },
    include: {
      _count: {
        select: {
          userMemberships: true,
          serviceAccountMemberships: true
        }
      }
    }
  })
  annotateRequestAuditLog(request, {
    action: 'create-auth-group',
    resource: 'auth role',
    summary: `Created auth role ${created.name}.`,
    metadata: {
      groupId: created.id,
      groupName: created.name,
      permissionCount: created.permissions.length
    }
  })
  response.status(201).json({ group: authGroupSchema.parse(toAuthGroupDto(request, created)) })
})

authManagementRouter.patch('/groups/:groupId', requireRequestPermission(AUTH_ROLES_EDIT_PERMISSION), async (request, response) => {
  const parsed = updateAuthGroupRequestSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest('Invalid auth group payload.')
  await requireRecentAuthManagementVerification(request)
  const groupId = requireRouteParam(request.params.groupId, 'groupId')
  const expandedPermissions = parsed.data.permissions ? expandWithImpliedPermissions(parsed.data.permissions) : undefined
  if (expandedPermissions) {
    assertContextVisiblePermissions(expandedPermissions)
    assertRequestPermission(request, AUTH_ROLES_ASSIGN_PERMISSION)
    assertCanAssignPermissions(request, expandedPermissions)
  }

  const existing = await prisma.authGroup.findFirst({ where: buildScopedAuthGroupWhere(groupId) })
  if (!existing) throw notFound('Auth group not found.')
  assertCanAssignPermissions(request, existing.permissions)
  if (!existing.isEditable) throw conflict('This auth role is not editable.')
  const affectedUserIds = await listGroupUserIds(groupId)

  const updated = await prisma.authGroup.update({
    where: { id: groupId },
    data: {
      name: parsed.data.name ?? existing.name,
      description: parsed.data.description === undefined ? existing.description : parsed.data.description,
      permissions: expandedPermissions ?? existing.permissions
    },
    include: {
      _count: {
        select: {
          userMemberships: true,
          serviceAccountMemberships: true
        }
      }
    }
  })

  annotateRequestAuditLog(request, {
    action: 'update-auth-group',
    resource: 'auth role',
    summary: `Updated auth role ${updated.name}.`,
    metadata: {
      groupId: updated.id,
      groupName: updated.name,
      permissionCount: updated.permissions.length
    }
  })

  broadcastAuthChangedForUsers(affectedUserIds)

  response.json({ group: authGroupSchema.parse(toAuthGroupDto(request, updated)) })
})

authManagementRouter.delete('/groups/:groupId', requireRequestPermission(AUTH_ROLES_DELETE_PERMISSION), async (request, response) => {
  const groupId = requireRouteParam(request.params.groupId, 'groupId')
  const existing = await prisma.authGroup.findFirst({ where: buildScopedAuthGroupWhere(groupId) })
  if (!existing) throw notFound('Auth group not found.')
  assertCanAssignPermissions(request, existing.permissions)
  if (!existing.isRemovable) throw conflict('This auth role cannot be removed.')
  const affectedUserIds = await listGroupUserIds(groupId)
  annotateRequestAuditLog(request, {
    action: 'delete-auth-group',
    resource: 'auth role',
    summary: `Deleted auth role ${existing.name}.`,
    metadata: {
      groupId: existing.id,
      groupName: existing.name
    }
  })
  await prisma.authGroup.delete({ where: { id: groupId } })
  broadcastAuthChangedForUsers(affectedUserIds)
  response.status(204).end()
})

authManagementRouter.get('/users', requireAuthenticatedRequestPermission(AUTH_USERS_VIEW_PERMISSION), async (_request, response) => {
  const users = await prisma.authUser.findMany({
    where: buildManageableAuthUserWhere(),
    orderBy: { email: 'asc' },
    include: buildScopedAuthUserInclude()
  })
  response.json(authUserListResponseSchema.parse({
    users: users.map((user) => toAuthUserDto(user, { canManage: canManageAuthUser(_request, user) }))
  }))
})

/**
 * People already in this workspace's organisation who are not in it yet.
 *
 * Lets the add-user dialog offer a pick list instead of asking for an email
 * that may typo into a stranger. Empty in a public build, which has no
 * organisations, so the dialog falls back to the email field it always had.
 *
 * Gated on the same permission as adding: knowing who is in the organisation is
 * only useful to someone who can act on it.
 */
authManagementRouter.get(
  '/users/organisation-candidates',
  requireAuthenticatedRequestPermission(AUTH_USERS_CREATE_PERMISSION),
  async (_request, response) => {
    const candidates = await listOrganisationCandidates(getCurrentWorkspace()?.id ?? null)
    response.json({ candidates })
  }
)

authManagementRouter.post('/users', requireAuthenticatedRequestPermission(AUTH_USERS_CREATE_PERMISSION), async (request, response) => {
  const parsed = createManagedAuthUserRequestSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest('Invalid auth user payload.')

  const workspaceId = getCurrentWorkspace()?.id ?? null
  const groupIds = parsed.data.groupIds

  if (groupIds.length > 0) {
    assertRequestPermission(request, AUTH_USERS_ASSIGN_ROLES_PERMISSION)
    assertRequestPermission(request, AUTH_ROLES_ASSIGN_PERMISSION)
    await requireRecentAuthManagementVerification(request)
  }

  const groups = await readExistingScopedGroups(groupIds)
  assertCanAssignAuthGroups(request, groups)
  const email = parsed.data.email.trim().toLowerCase()
  const displayName = parsed.data.displayName?.trim() || null

  // The account owner can stop workspace admins introducing people the
  // organisation has never seen. Deliberately not a workspace permission: a
  // workspace admin holds `auth.roles.edit` and could grant one back to
  // themselves, so the restriction sits above workspace roles.
  //
  // Assigning someone already IN the organisation is untouched — that is the
  // day-to-day act this must not get in the way of.
  await assertWorkspaceMayAddPerson(workspaceId, email)

  try {
    const createdUserId = await createManagedAuthUser({
      workspaceId,
      email,
      displayName,
      groupIds
    })
    // A workspace member is a member of that workspace's organisation. Applied
    // here, on the write, so the two can never disagree — and one-directional:
    // this does not put anyone in a workspace, nor grant them any billing.
    await joinWorkspaceOrganisation(workspaceId, createdUserId)

    const hydratedUser = await prisma.authUser.findFirst({
      where: buildManageableAuthUserWhere(createdUserId),
      include: buildScopedAuthUserInclude()
    })
    if (!hydratedUser) throw notFound('Auth user not found.')

    annotateRequestAuditLog(request, {
      action: 'create-auth-user',
      resource: 'auth user',
      summary: `Created auth user ${hydratedUser.email}.`,
      metadata: {
        userId: hydratedUser.id,
        email: hydratedUser.email
      }
    })

    response.status(201).json(authUserResponseSchema.parse({
      user: toAuthUserDto(hydratedUser)
    }))
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflict('An auth user with that email already exists.')
    }
    throw error
  }
})

authManagementRouter.patch('/users/:userId/groups', requireAuthenticatedRequestPermission(AUTH_USERS_ASSIGN_ROLES_PERMISSION), async (request, response) => {
  const parsed = updateAuthUserGroupsRequestSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest('Invalid auth user group payload.')
  await requireRecentAuthManagementVerification(request)
  assertRequestPermission(request, AUTH_ROLES_ASSIGN_PERMISSION)

  const userId = requireRouteParam(request.params.userId, 'userId')
  const existing = await prisma.authUser.findFirst({
    where: buildManageableAuthUserWhere(userId),
    include: buildScopedAuthUserInclude()
  })
  if (!existing) throw notFound('Auth user not found.')

  assertCanManageAuthUser(request, existing)
  const groups = await readExistingScopedGroups(parsed.data.groupIds)
  assertCanAssignAuthGroups(request, groups)
  await assertMembershipChangeAllowed(request, existing, { nextGroupIds: parsed.data.groupIds })
  await syncUserGroupMemberships(userId, parsed.data.groupIds)

  const updated = await prisma.authUser.findFirst({
    where: buildManageableAuthUserWhere(userId),
    include: buildScopedAuthUserInclude()
  })
  if (!updated) throw notFound('Auth user not found.')

  annotateRequestAuditLog(request, {
    action: 'update-auth-user-groups',
    resource: 'auth user',
    summary: `Updated role assignments for ${updated.email}.`,
    metadata: {
      userId: updated.id,
      email: updated.email,
      groupIds: parsed.data.groupIds
    }
  })

  broadcastAuthChangedForUsers([updated.id])

  response.json({ user: authUserResponseSchema.shape.user.parse(toAuthUserDto(updated)) })
})

authManagementRouter.patch('/users/:userId', requireAuthenticatedCurrentUser(), async (request, response) => {
  const parsed = updateAuthUserRequestSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest('Invalid auth user payload.')

  const userId = requireRouteParam(request.params.userId, 'userId')
  assertUserUpdatePermissions(request, parsed.data)
  const existing = await prisma.authUser.findFirst({
    where: buildManageableAuthUserWhere(userId),
    include: buildScopedAuthUserInclude()
  })
  if (!existing) throw notFound('Auth user not found.')
  assertCanManageAuthUser(request, existing)

  if (parsed.data.loginDisabled && isCurrentActorUser(request, userId)) {
    throw conflict('You cannot disable the account you are currently using.')
  }

  if (!getCurrentWorkspace() && parsed.data.loginDisabled !== undefined) {
    throw badRequest('Workspace context is required to change sign-in status.')
  }

  await assertMembershipChangeAllowed(request, existing, { nextLoginDisabled: parsed.data.loginDisabled })

  try {
    await prisma.$transaction(async (tx) => {
      if (parsed.data.loginDisabled !== undefined && getCurrentWorkspace()?.id) {
        await tx.authWorkspaceMembership.update({
          where: {
            userId_workspaceId: {
              userId,
              workspaceId: getCurrentWorkspace()!.id
            }
          },
          data: {
            loginDisabled: parsed.data.loginDisabled
          }
        })
      }
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflict('An auth user with that email already exists.')
    }
    throw error
  }

  const updated = await prisma.authUser.findFirst({
    where: buildManageableAuthUserWhere(userId),
    include: buildScopedAuthUserInclude()
  })
  if (!updated) throw notFound('Auth user not found.')

  annotateRequestAuditLog(request, {
    action: 'update-auth-user',
    resource: 'auth user',
    summary: `Updated auth user ${updated.email}.`,
    metadata: {
      userId: updated.id,
      email: updated.email,
      loginDisabled: readScopedAuthUserLoginDisabled(updated)
    }
  })

  broadcastAuthChangedForUsers([updated.id])

  response.json(authUserResponseSchema.parse({
    user: toAuthUserDto(updated)
  }))
})

authManagementRouter.delete('/users/:userId', requireAuthenticatedRequestPermission(AUTH_USERS_DELETE_PERMISSION), async (request, response) => {
  const userId = requireRouteParam(request.params.userId, 'userId')
  const user = await prisma.authUser.findFirst({
    where: buildManageableAuthUserWhere(userId),
    include: buildScopedAuthUserInclude()
  })
  if (!user) throw notFound('Auth user not found.')
  assertCanManageAuthUser(request, user)
  if (isCurrentActorUser(request, userId)) {
    throw conflict('You cannot delete the account you are currently using.')
  }

  await assertMembershipChangeAllowed(request, user, { deleting: true })

  annotateRequestAuditLog(request, {
    action: 'delete-auth-user',
    resource: 'auth user',
    summary: `Deleted auth user ${user.email}.`,
    metadata: {
      userId: user.id,
      email: user.email
    }
  })

  await deleteManagedAuthUser(userId)
  broadcastAuthChangedForUsers([user.id])
  response.status(204).end()
})

authManagementRouter.get('/users/:userId/sessions', requireAuthenticatedRequestPermission(AUTH_USERS_VIEW_SESSIONS_PERMISSION), async (request, response) => {
  const userId = requireRouteParam(request.params.userId, 'userId')
  const user = await prisma.authUser.findFirst({
    where: buildManageableAuthUserWhere(userId),
    include: buildScopedAuthUserInclude()
  })
  if (!user) throw notFound('Auth user not found.')
  assertCanManageAuthUser(request, user)

  const currentSessionSecretHash = readRequestAuthSessionSecretHash(request)
  const sessions = await prisma.authSession.findMany({
    where: {
      userId,
      revokedAt: null,
      expiresAt: {
        gt: new Date()
      }
    },
    orderBy: [
      { createdAt: 'desc' }
    ]
  })

  response.json(authSessionListResponseSchema.parse({
    sessions: sessions.map((session) => toAuthSessionSummaryDto(session, currentSessionSecretHash))
  }))
})

authManagementRouter.post('/users/:userId/sessions/:sessionId/revoke', requireAuthenticatedRequestPermission(AUTH_USERS_REVOKE_SESSIONS_PERMISSION), async (request, response) => {
  const userId = requireRouteParam(request.params.userId, 'userId')
  const sessionId = requireRouteParam(request.params.sessionId, 'sessionId')
  const user = await prisma.authUser.findFirst({
    where: buildManageableAuthUserWhere(userId),
    include: buildScopedAuthUserInclude()
  })
  if (!user) throw notFound('Auth user not found.')
  assertCanManageAuthUser(request, user)

  const currentSessionSecretHash = readRequestAuthSessionSecretHash(request)
  const session = await prisma.authSession.findFirst({
    where: {
      id: sessionId,
      userId,
      revokedAt: null,
      expiresAt: {
        gt: new Date()
      }
    }
  })
  if (!session) throw notFound('Session not found or no longer active.')
  if (currentSessionSecretHash != null && session.secretHash === currentSessionSecretHash) {
    throw conflict('Use sign out to revoke the session you are currently using.')
  }

  annotateRequestAuditLog(request, {
    action: 'revoke-user-session',
    resource: 'session',
    summary: `Revoked an active browser session for ${user.email}.`,
    metadata: {
      userId: user.id,
      sessionId: session.id
    }
  })
  await prisma.authSession.updateMany({
    where: {
      id: session.id,
      revokedAt: null
    },
    data: {
      revokedAt: new Date()
    }
  })
  broadcastAuthChangedForUsers([user.id])
  response.status(204).end()
})

authManagementRouter.get('/service-accounts', requireAuthenticatedRequestPermission(AUTH_SERVICE_ACCOUNTS_VIEW_PERMISSION), async (_request, response) => {
  if (!getCurrentWorkspace()) {
    response.json(authServiceAccountListResponseSchema.parse({ serviceAccounts: [] }))
    return
  }

  const serviceAccounts = await prisma.authServiceAccount.findMany({
    where: buildScopedAuthServiceAccountWhere(),
    orderBy: { name: 'asc' },
    include: authServiceAccountInclude
  })
  response.json(authServiceAccountListResponseSchema.parse({
    serviceAccounts: serviceAccounts.map((serviceAccount) => toAuthServiceAccountDto(_request, serviceAccount))
  }))
})

authManagementRouter.post('/service-accounts', requireAuthenticatedRequestPermission(AUTH_SERVICE_ACCOUNTS_CREATE_PERMISSION), async (request, response) => {
  const parsed = createAuthServiceAccountRequestSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest('Invalid service account payload.')

  if (parsed.data.groupIds.length > 0) {
    assertRequestPermission(request, AUTH_SERVICE_ACCOUNTS_ASSIGN_ROLES_PERMISSION)
    assertRequestPermission(request, AUTH_ROLES_ASSIGN_PERMISSION)
    await requireRecentAuthManagementVerification(request)
  }

  const groups = await readExistingScopedGroups(parsed.data.groupIds)
  assertCanAssignAuthGroups(request, groups)
  const workspaceId = requireWorkspaceId()
  const token = createServiceAccountToken()
  const created = await prisma.authServiceAccount.create({
    data: {
      workspaceId,
      name: parsed.data.name,
      tokenHash: hashServiceAccountToken(token),
      tokenPrefix: createServiceAccountTokenPrefix(token),
      memberships: parsed.data.groupIds.length > 0
        ? {
          create: parsed.data.groupIds.map((groupId) => ({ groupId }))
        }
        : undefined
    },
    include: authServiceAccountInclude
  })

  annotateRequestAuditLog(request, {
    action: 'create-service-account',
    resource: 'service account',
    summary: `Created service account ${created.name}.`,
    metadata: {
      serviceAccountId: created.id,
      serviceAccountName: created.name,
      groupIds: parsed.data.groupIds
    }
  })

  response.status(201).json(createAuthServiceAccountResponseSchema.parse({
    serviceAccount: toAuthServiceAccountDto(request, created),
    token
  }))
})

authManagementRouter.patch('/service-accounts/:serviceAccountId', requireAuthenticatedRequestPermission(AUTH_SERVICE_ACCOUNTS_EDIT_PERMISSION), async (request, response) => {
  const parsed = updateAuthServiceAccountRequestSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest('Invalid service account payload.')

  if (parsed.data.groupIds !== undefined) {
    assertRequestPermission(request, AUTH_SERVICE_ACCOUNTS_ASSIGN_ROLES_PERMISSION)
    assertRequestPermission(request, AUTH_ROLES_ASSIGN_PERMISSION)
    await requireRecentAuthManagementVerification(request)
  }

  const serviceAccountId = requireRouteParam(request.params.serviceAccountId, 'serviceAccountId')
  const existing = await prisma.authServiceAccount.findFirst({
    where: buildScopedAuthServiceAccountWhere(serviceAccountId),
    include: authServiceAccountInclude
  })
  if (!existing) throw notFound('Service account not found.')
  assertCanManageAuthServiceAccount(request, existing)

  if (parsed.data.groupIds !== undefined) {
    const groups = await readExistingScopedGroups(parsed.data.groupIds)
    assertCanAssignAuthGroups(request, groups)
  }

  if (parsed.data.name !== undefined) {
    await prisma.authServiceAccount.update({
      where: { id: serviceAccountId },
      data: {
        name: parsed.data.name
      }
    })
  }

  if (parsed.data.groupIds !== undefined) {
    await syncServiceAccountGroupMemberships(serviceAccountId, parsed.data.groupIds)
  }

  const updated = await prisma.authServiceAccount.findFirst({
    where: buildScopedAuthServiceAccountWhere(serviceAccountId),
    include: authServiceAccountInclude
  })
  if (!updated) throw notFound('Service account not found.')

  annotateRequestAuditLog(request, {
    action: 'update-service-account',
    resource: 'service account',
    summary: `Updated service account ${updated.name}.`,
    metadata: {
      serviceAccountId: updated.id,
      serviceAccountName: updated.name,
      groupIds: parsed.data.groupIds
    }
  })

  response.json({ serviceAccount: authServiceAccountSchema.parse(toAuthServiceAccountDto(request, updated)) })
})

authManagementRouter.post('/service-accounts/:serviceAccountId/revoke', requireAuthenticatedRequestPermission(AUTH_SERVICE_ACCOUNTS_REVOKE_PERMISSION), async (request, response) => {
  const serviceAccountId = requireRouteParam(request.params.serviceAccountId, 'serviceAccountId')
  const existing = await prisma.authServiceAccount.findFirst({
    where: buildScopedAuthServiceAccountWhere(serviceAccountId),
    include: authServiceAccountInclude
  })
  if (!existing) throw notFound('Service account not found.')
  assertCanManageAuthServiceAccount(request, existing)

  if (!existing.revokedAt) {
    await prisma.authServiceAccount.update({
      where: { id: serviceAccountId },
      data: {
        revokedAt: new Date()
      }
    })
  }

  const revoked = await prisma.authServiceAccount.findFirst({
    where: buildScopedAuthServiceAccountWhere(serviceAccountId),
    include: authServiceAccountInclude
  })
  if (!revoked) throw notFound('Service account not found.')

  annotateRequestAuditLog(request, {
    action: 'revoke-service-account',
    resource: 'service account',
    summary: `Revoked service account ${revoked.name}.`,
    metadata: {
      serviceAccountId: revoked.id,
      serviceAccountName: revoked.name
    }
  })

  response.json({ serviceAccount: authServiceAccountSchema.parse(toAuthServiceAccountDto(request, revoked)) })
})

authManagementRouter.get('/session-policy', requireRequestPermission(AUTH_SESSION_POLICY_MANAGE_PERMISSION), async (_request, response) => {
  response.json(authSessionPolicySchema.parse({
    sessionDuration: await readAuthSessionDuration(prisma)
  }))
})

authManagementRouter.put('/session-policy', requireRequestPermission(AUTH_SESSION_POLICY_MANAGE_PERMISSION), async (request, response) => {
  const parsed = updateAuthSessionPolicyRequestSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid auth session policy payload.')

  await writeAuthSessionDuration(prisma, parsed.data.sessionDuration)

  annotateRequestAuditLog(request, {
    action: 'update-session-policy',
    resource: 'session policy',
    summary: 'Updated the browser session duration policy.',
    metadata: {
      sessionDuration: parsed.data.sessionDuration
    }
  })

  response.json(authSessionPolicySchema.parse({
    sessionDuration: parsed.data.sessionDuration
  }))
})

async function requireRecentAuthManagementVerification(request: Request): Promise<void> {
  if (!request.auth.authEnabled) {
    return
  }

  if (request.auth.actor.type !== 'user') {
    throw unauthorized(AUTHENTICATION_REQUIRED_MESSAGE)
  }

  await requireRecentUserSession(prisma, request, request.auth.actor.userId)
}

async function requireCurrentAuthUser(request: Request): Promise<AuthUserRow> {
  if (request.auth.actor.type !== 'user') {
    throw unauthorized(AUTHENTICATION_REQUIRED_MESSAGE)
  }

  const user = await prisma.authUser.findFirst({
    where: buildCurrentAuthUserWhere(request.auth.actor.userId),
    include: buildScopedAuthUserInclude()
  })
  if (!user || readScopedAuthUserLoginDisabled(user)) {
    throw unauthorized(AUTHENTICATION_REQUIRED_MESSAGE)
  }
  return user
}

function assertUserUpdatePermissions(
  request: Request,
  update: { loginDisabled?: boolean }
): void {
  if (update.loginDisabled !== undefined) {
    assertRequestPermission(request, AUTH_USERS_DISABLE_SIGN_IN_PERMISSION)
  }
}

/**
 * Describes a pending membership change, for the guards that must vet it.
 *
 * `nextGroupIds === undefined` means "not changing roles" — distinct from an
 * empty array, which means "remove every role".
 */
interface MembershipChange {
  nextGroupIds?: string[]
  nextLoginDisabled?: boolean
  deleting?: boolean
}

/**
 * Whether this change would take away what protects the user: their admin role,
 * their ability to sign in, or their existence.
 *
 * Computed ONCE and shared by both guards below. It used to be written out in
 * each of them — the same `nextGroupIds !== undefined && !memberships.some(...)`
 * expression, differing only in whether the admin key was read from a local
 * variable — so a fix to one (a group id from another workspace, a renamed admin
 * key, a nested-group role) would have silently left the other on the old
 * behaviour, firing one guard and not the other on the same request.
 */
function changeRemovesProtection(user: AuthUserRow, change: MembershipChange): boolean {
  if (change.deleting) return true
  if (change.nextLoginDisabled === true) return true
  return change.nextGroupIds !== undefined && !user.memberships.some(
    (membership) => membership.group.key === ADMIN_GROUP_KEY && change.nextGroupIds?.includes(membership.group.id)
  )
}

/**
 * Vet a membership change against both protections, in the order whose message
 * the caller should see first.
 *
 * One entry point because the two guards were always called back to back with
 * the same argument, and a fourth membership-mutating route would otherwise get
 * whichever one its author remembered. Lockout first: "you would lock yourself
 * out" is about the actor and is the more actionable of the two.
 */
async function assertMembershipChangeAllowed(
  request: Request,
  user: AuthUserRow,
  change: MembershipChange
): Promise<void> {
  await assertAdminLockoutNotTriggered(request, user, change)
  await assertProtectedMemberNotStranded(user, change)
}

/**
 * Refuse a change that would strip the account owner of access to a workspace
 * their account owns.
 *
 * Distinct from `assertAdminLockoutNotTriggered`, which protects the LAST admin
 * whoever they are: this protects a specific person regardless of how many other
 * admins exist, because a workspace admin who is not the owner must not be able
 * to lock the payer out of what they are being billed for. Both run, and either
 * may fire.
 *
 * Only the changes that actually strand them: a role edit that leaves them an
 * admin, or any other field on their user, is none of this guard's business.
 */
async function assertProtectedMemberNotStranded(user: AuthUserRow, change: MembershipChange): Promise<void> {
  if (!changeRemovesProtection(user, change)) return

  const reason = await protectedWorkspaceMemberReason(getCurrentWorkspace()?.id ?? null, user.id)
  if (reason) throw conflict(reason)
}

async function assertAdminLockoutNotTriggered(
  request: Request,
  user: AuthUserRow,
  change: MembershipChange
): Promise<void> {
  if (!isEnabledAdminUser(user)) {
    return
  }

  const workspaceId = getCurrentWorkspace()?.id ?? null
  if (workspaceId && !shouldPreventWorkspaceSelfLockout(request, user.id)) {
    return
  }

  if (!changeRemovesProtection(user, change)) {
    return
  }

  const otherEnabledAdminCount = await prisma.authUser.count({
    where: workspaceId
      ? {
          id: { not: user.id },
          workspaceMemberships: {
            some: buildEnabledWorkspaceMembershipWhere(workspaceId)
          },
          memberships: {
            some: {
              group: {
                workspaceId,
                key: ADMIN_GROUP_KEY
              }
            }
          }
        }
      : {
          id: { not: user.id },
          isPlatformUser: true,
          memberships: {
            some: {
              group: {
                workspaceId: null,
                key: ADMIN_GROUP_KEY
              }
            }
          }
        }
  })

  if (otherEnabledAdminCount === 0) {
    throw conflict('At least one enabled Admin user must remain to prevent lockout.')
  }
}

async function readExistingScopedGroups(groupIds: string[]): Promise<Array<{ id: string; permissions: string[] }>> {
  if (groupIds.length === 0) return []
  const groups = await prisma.authGroup.findMany({
    where: {
      ...buildScopedAuthGroupWhere(),
      id: { in: groupIds }
    },
    select: { id: true, permissions: true }
  })
  if (groups.length !== groupIds.length) {
    throw notFound('One or more auth groups were not found.')
  }
  return groups
}

function assertCanManageAuthUser(request: Request, user: AuthUserRow): void {
  if (canManageAuthUser(request, user)) return
  throw forbidden(CANNOT_MANAGE_HIGHER_USER_MESSAGE)
}

function assertCanManageAuthServiceAccount(request: Request, serviceAccount: AuthServiceAccountRow): void {
  if (!request.auth.authEnabled) return
  if (permissionsAreManageableByActor(request.auth, readAuthServiceAccountGrantedPermissions(serviceAccount))) return
  throw forbidden(CANNOT_MANAGE_HIGHER_SERVICE_ACCOUNT_MESSAGE)
}

function canManageAuthUser(request: Request, user: AuthUserRow): boolean {
  if (!request.auth.authEnabled) return true
  return permissionsAreManageableByActor(request.auth, readAuthUserGrantedPermissions(user))
}

function assertCanAssignAuthGroups(request: Request, groups: Array<{ permissions: string[] }>): void {
  const permissions = groups.flatMap((group) => group.permissions)
  assertCanAssignPermissions(request, permissions)
}

function assertCanAssignPermissions(request: Request, permissions: readonly string[]): void {
  if (!request.auth.authEnabled) return
  if (permissionsAreManageableByActor(request.auth, permissions)) return
  throw forbidden(CANNOT_ASSIGN_HIGHER_ROLE_MESSAGE)
}

async function ensureScopedBuiltInAuthGroups(): Promise<void> {
  const workspaceId = getCurrentWorkspace()?.id
  if (workspaceId) {
    await ensureBuiltInAuthGroups(prisma, workspaceId)
    return
  }

  await ensureBuiltInPlatformAuthGroups(prisma)
}

function readAuthUserGrantedPermissions(user: AuthUserRow): Permission[] {
  return Array.from(new Set(
    user.memberships.flatMap((membership) => membership.group.permissions as Permission[])
  ))
}

function readAuthServiceAccountGrantedPermissions(serviceAccount: AuthServiceAccountRow): Permission[] {
  return Array.from(new Set(
    serviceAccount.memberships.flatMap((membership) => membership.group.permissions as Permission[])
  ))
}

async function listGroupUserIds(groupId: string): Promise<string[]> {
  const rows = await prisma.authUserGroupMembership.findMany({
    where: { groupId },
    select: { userId: true }
  })
  return rows.map((row) => row.userId)
}

async function syncUserGroupMemberships(userId: string, groupIds: string[]): Promise<void> {
  const workspaceId = getCurrentWorkspace()?.id ?? null
  await prisma.authUserGroupMembership.deleteMany({
    where: {
      userId,
      group: {
        workspaceId
      }
    }
  })
  if (groupIds.length === 0) return
  await prisma.authUserGroupMembership.createMany({
    data: groupIds.map((groupId) => ({ userId, groupId }))
  })
}

async function syncServiceAccountGroupMemberships(serviceAccountId: string, groupIds: string[]): Promise<void> {
  await prisma.authServiceAccountGroupMembership.deleteMany({ where: { serviceAccountId } })
  if (groupIds.length === 0) return
  await prisma.authServiceAccountGroupMembership.createMany({
    data: groupIds.map((groupId) => ({ serviceAccountId, groupId }))
  })
}

function toAuthGroupDto(request: Request, row: AuthGroupWithCounts) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    permissions: getCurrentWorkspace()
      ? row.permissions.filter((permission) => isPermissionVisibleInWorkspaceContext(permission as Parameters<typeof isPermissionVisibleInWorkspaceContext>[0]))
      : row.permissions.filter((permission) => isPermissionVisibleInPlatformContext(permission as Parameters<typeof isPermissionVisibleInPlatformContext>[0])),
    isSystem: row.isSystem,
    canManage: permissionsAreManageableByActor(request.auth, row.permissions),
    isEditable: row.isEditable,
    isRemovable: row.isRemovable,
    userCount: row._count.userMemberships,
    serviceAccountCount: row._count.serviceAccountMemberships,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

/** Expands a permission set by adding any implied prerequisite permissions. */
function expandWithImpliedPermissions(permissions: Permission[]): Permission[] {
  const implied = resolveImpliedPermissions(permissions)
  if (implied.length === 0) return permissions
  const expanded = new Set(permissions)
  for (const permission of implied) {
    expanded.add(permission)
  }
  return [...expanded]
}

function assertContextVisiblePermissions(permissions: readonly string[]): void {
  const workspace = getCurrentWorkspace()
  const hidden = permissions.some((permission) => {
    const knownPermission = permission as Parameters<typeof isPermissionVisibleInWorkspaceContext>[0]
    return workspace
      ? !isPermissionVisibleInWorkspaceContext(knownPermission)
      : !isPermissionVisibleInPlatformContext(knownPermission)
  })
  if (hidden) {
    throw badRequest(workspace
      ? 'One or more permissions are not available in this workspace.'
      : 'One or more permissions are not available for platform roles.')
  }
}

function toAuthServiceAccountDto(request: Request, row: AuthServiceAccountRow) {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    canManage: permissionsAreManageableByActor(request.auth, readAuthServiceAccountGrantedPermissions(row)),
    groups: toSortedGroupSummaries(row.memberships.map((membership) => membership.group)),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

function toAuthSessionSummaryDto(row: AuthSessionRow, currentSessionSecretHash: string | null) {
  return {
    id: row.id,
    current: currentSessionSecretHash != null && row.secretHash === currentSessionSecretHash,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString()
  }
}

function createServiceAccountToken(): string {
  return `bhs_${crypto.randomBytes(6).toString('hex')}_${crypto.randomBytes(24).toString('base64url')}`
}

function createServiceAccountTokenPrefix(token: string): string {
  const segments = token.split('_')
  const prefix = segments.length >= 2 ? `${segments[0]}_${segments[1]}` : token.slice(0, 16)
  return prefix.slice(0, 32)
}

function isEnabledAdminUser(user: AuthUserRow): boolean {
  const workspaceId = getCurrentWorkspace()?.id ?? null
  if (!workspaceId) {
    return user.isPlatformUser && user.memberships.some((membership) => membership.group.key === ADMIN_GROUP_KEY)
  }

  return !readScopedAuthUserLoginDisabled(user) && user.memberships.some((membership) => membership.group.key === ADMIN_GROUP_KEY)
}

function isCurrentActorUser(request: Request, userId: string): boolean {
  return request.auth.actor.type === 'user' && request.auth.actor.userId === userId
}

function shouldPreventWorkspaceSelfLockout(request: Request, userId: string): boolean {
  if (!isCurrentActorUser(request, userId)) return false
  return !(request.auth.actor.type === 'user' && request.auth.actor.isPlatformUser)
}

function requireWorkspaceId(): string {
  const workspaceId = getCurrentWorkspace()?.id
  if (workspaceId) {
    return workspaceId
  }
  throw badRequest('Workspace context is required.')
}

function buildScopedAuthGroupWhere(id?: string): Prisma.AuthGroupWhereInput {
  const workspaceId = getCurrentWorkspace()?.id ?? null
  return {
    ...(id ? { id } : {}),
    workspaceId
  }
}

function buildScopedAuthServiceAccountWhere(id?: string): Prisma.AuthServiceAccountWhereInput {
  return {
    ...(id ? { id } : {}),
    workspaceId: getCurrentWorkspace()?.id ?? NEVER_MATCH_WORKSPACE_ID
  }
}