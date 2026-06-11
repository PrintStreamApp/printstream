/**
 * Development-only auth data reset helpers.
 *
 * Resets identity, access, sessions, service accounts, and auth-provider
 * setup state while preserving operational tenant data. Built-in platform and
 * tenant roles are reseeded immediately so follow-up setup flows have the
 * expected role invariants available.
 */
import {
  ensureBuiltInAuthGroups,
  ensureBuiltInPlatformAuthGroups,
  type BuiltInAuthGroupClient
} from './default-auth-groups.js'

type DeleteResult = { count: number }
type TenantSummary = { id: string; slug: string; name: string }

interface AuthResetPrismaClient extends BuiltInAuthGroupClient {
  tenant: {
    findMany(args: { select: { id: true; slug: true; name: true } }): Promise<TenantSummary[]>
  }
  authSession: CountableDeleteableModel
  authEmailCodeToken: DeleteableModel
  authPasskeyCredential: DeleteableModel
  authUserGroupMembership: DeleteableModel
  authServiceAccountGroupMembership: DeleteableModel
  authTenantMembership: CountableDeleteableModel
  authServiceAccount: CountableDeleteableModel
  authUser: CountableDeleteableModel
  authGroup: BuiltInAuthGroupClient['authGroup'] & CountableDeleteableModel
  setting: CountableDeleteableModel
  $transaction<T>(run: (tx: AuthResetPrismaClient) => Promise<T>): Promise<T>
}

interface DeleteableModel {
  deleteMany(args?: unknown): Promise<DeleteResult>
}

interface CountableDeleteableModel extends DeleteableModel {
  count(args?: unknown): Promise<number>
}

export const authResetSettingWhere = {
  OR: [
    { key: { startsWith: 'plugin:auth-local:' } },
    { key: { startsWith: 'plugin:auth-oauth:' } },
    { key: { contains: ':auth:sessionDuration' } },
    { key: { contains: ':auth:supportAccess' } },
    { key: { startsWith: 'auth:' } }
  ]
}

export interface AuthResetCounts {
  users: number
  roles: number
  tenantMemberships: number
  serviceAccounts: number
  sessions: number
  authSettings: number
}

export interface AuthResetResult {
  tenantsPreserved: TenantSummary[]
  before: AuthResetCounts
  deleted: Record<string, number>
  reseededRoles: number
  after: AuthResetCounts
}

export async function resetAuthData(prisma: AuthResetPrismaClient): Promise<AuthResetResult> {
  const before = await readAuthResetCounts(prisma)

  const result = await prisma.$transaction(async (tx) => {
    const tenants = await tx.tenant.findMany({ select: { id: true, slug: true, name: true } })
    const deleted = {
      authSessions: await tx.authSession.deleteMany(),
      authEmailCodeTokens: await tx.authEmailCodeToken.deleteMany(),
      authPasskeys: await tx.authPasskeyCredential.deleteMany(),
      authUserGroupMemberships: await tx.authUserGroupMembership.deleteMany(),
      authServiceAccountGroupMemberships: await tx.authServiceAccountGroupMembership.deleteMany(),
      authTenantMemberships: await tx.authTenantMembership.deleteMany(),
      authServiceAccounts: await tx.authServiceAccount.deleteMany(),
      authUsers: await tx.authUser.deleteMany(),
      authGroups: await tx.authGroup.deleteMany(),
      authSettings: await tx.setting.deleteMany({ where: authResetSettingWhere })
    }

    await ensureBuiltInPlatformAuthGroups(tx)
    for (const tenant of tenants) {
      await ensureBuiltInAuthGroups(tx, tenant.id)
    }

    return { tenants, deleted, roles: await tx.authGroup.count() }
  })

  return {
    tenantsPreserved: result.tenants,
    before,
    deleted: Object.fromEntries(Object.entries(result.deleted).map(([key, value]) => [key, value.count])),
    reseededRoles: result.roles,
    after: await readAuthResetCounts(prisma)
  }
}

export async function readAuthResetCounts(prisma: AuthResetPrismaClient): Promise<AuthResetCounts> {
  const [users, roles, tenantMemberships, serviceAccounts, sessions, authSettings] = await Promise.all([
    prisma.authUser.count(),
    prisma.authGroup.count(),
    prisma.authTenantMembership.count(),
    prisma.authServiceAccount.count(),
    prisma.authSession.count(),
    prisma.setting.count({ where: authResetSettingWhere })
  ])

  return { users, roles, tenantMemberships, serviceAccounts, sessions, authSettings }
}