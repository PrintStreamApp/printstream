/**
 * Home Assistant token lifecycle helpers.
 *
 * The Home Assistant integration uses a plugin-owned, tenant-scoped service
 * account so the plugin can guide setup, detect deleted or revoked access,
 * and regenerate a replacement token without sending users through the full
 * auth-management UI.
 */
import crypto from 'node:crypto'
import {
  CAMERA_VIEW_PERMISSION,
  LIBRARY_DOWNLOAD_PERMISSION,
  PRINTERS_CONTROL_PERMISSION,
  PRINTERS_MANAGE_PERMISSION,
  homeAssistantAccessStatusSchema,
  homeAssistantCreateAccessTokenResponseSchema,
  type HomeAssistantAccessStatus,
  type HomeAssistantAccessTokenState,
  type HomeAssistantManagedServiceAccount,
  resolveImpliedPermissions,
  type Permission
} from '@printstream/shared'
import { hashServiceAccountToken } from '../../lib/auth-session.js'
import type { TenantScopedPrismaClient } from '../../lib/prisma.js'
import type { PluginSettingStore } from '../../plugin/types.js'

const HOME_ASSISTANT_SERVICE_ACCOUNT_ID_SETTING = 'serviceAccountId'
const HOME_ASSISTANT_AUTH_GROUP_KEY = 'home_assistant'
const HOME_ASSISTANT_AUTH_GROUP_NAME = 'Home Assistant'
const HOME_ASSISTANT_AUTH_GROUP_DESCRIPTION = 'Used by the Home Assistant plugin to issue a tenant-scoped automation token.'
const HOME_ASSISTANT_SERVICE_ACCOUNT_NAME = 'Home Assistant'

type ManagedServiceAccountRow = {
  id: string
  name: string
  tokenPrefix: string
  revokedAt: Date | null
  createdAt: Date
  updatedAt: Date
  memberships: Array<{
    group: {
      permissions: string[]
    }
  }>
}

const authServiceAccountInclude = {
  memberships: {
    select: {
      group: {
        select: {
          permissions: true
        }
      }
    }
  }
} as const

const HOME_ASSISTANT_RECOMMENDED_PERMISSIONS = expandWithImpliedPermissions([
  PRINTERS_CONTROL_PERMISSION,
  PRINTERS_MANAGE_PERMISSION,
  CAMERA_VIEW_PERMISSION,
  LIBRARY_DOWNLOAD_PERMISSION
])

export async function readHomeAssistantAccessStatus(
  prisma: TenantScopedPrismaClient,
  settings: PluginSettingStore
): Promise<HomeAssistantAccessStatus> {
  const trackedServiceAccountId = await settings.get(HOME_ASSISTANT_SERVICE_ACCOUNT_ID_SETTING)
  if (!trackedServiceAccountId) {
    return homeAssistantAccessStatusSchema.parse({
      tokenRequired: true,
      recommendedPermissions: HOME_ASSISTANT_RECOMMENDED_PERMISSIONS,
      state: 'missing',
      serviceAccount: null,
      missingPermissions: []
    })
  }

  const serviceAccount = await prisma.authServiceAccount.findFirst({
    where: { id: trackedServiceAccountId },
    include: authServiceAccountInclude
  }) as ManagedServiceAccountRow | null

  if (!serviceAccount) {
    return homeAssistantAccessStatusSchema.parse({
      tokenRequired: true,
      recommendedPermissions: HOME_ASSISTANT_RECOMMENDED_PERMISSIONS,
      state: 'deleted',
      serviceAccount: null,
      missingPermissions: []
    })
  }

  const grantedPermissions = new Set(serviceAccount.memberships.flatMap((membership) => membership.group.permissions) as Permission[])
  const missingPermissions = HOME_ASSISTANT_RECOMMENDED_PERMISSIONS.filter((permission) => !grantedPermissions.has(permission))
  const state: HomeAssistantAccessTokenState = serviceAccount.revokedAt
    ? 'revoked'
    : missingPermissions.length > 0
      ? 'misconfigured'
      : 'active'

  return homeAssistantAccessStatusSchema.parse({
    tokenRequired: true,
    recommendedPermissions: HOME_ASSISTANT_RECOMMENDED_PERMISSIONS,
    state,
    serviceAccount: toManagedServiceAccountDto(serviceAccount),
    missingPermissions
  })
}

export async function createHomeAssistantAccessToken(
  prisma: TenantScopedPrismaClient,
  settings: PluginSettingStore,
  tenantId: string
): Promise<{ serviceAccount: HomeAssistantManagedServiceAccount; token: string }> {
  await ensureHomeAssistantAuthGroup(prisma, tenantId)

  const previousServiceAccountId = await settings.get(HOME_ASSISTANT_SERVICE_ACCOUNT_ID_SETTING)
  if (previousServiceAccountId) {
    const existing = await prisma.authServiceAccount.findFirst({
      where: { id: previousServiceAccountId },
      select: {
        id: true,
        revokedAt: true
      }
    })

    if (existing && existing.revokedAt == null) {
      await prisma.authServiceAccount.update({
        where: { id: existing.id },
        data: {
          revokedAt: new Date()
        }
      })
    }
  }

  const token = createServiceAccountToken()
  const created = await prisma.authServiceAccount.create({
    data: {
      tenantId,
      name: HOME_ASSISTANT_SERVICE_ACCOUNT_NAME,
      tokenHash: hashServiceAccountToken(token),
      tokenPrefix: createServiceAccountTokenPrefix(token),
      memberships: {
        create: {
          group: {
            connect: {
              tenantId_key: {
                tenantId,
                key: HOME_ASSISTANT_AUTH_GROUP_KEY
              }
            }
          }
        }
      }
    },
    include: authServiceAccountInclude
  }) as ManagedServiceAccountRow

  await settings.set(HOME_ASSISTANT_SERVICE_ACCOUNT_ID_SETTING, created.id)

  return homeAssistantCreateAccessTokenResponseSchema.parse({
    serviceAccount: toManagedServiceAccountDto(created),
    token
  })
}

function toManagedServiceAccountDto(serviceAccount: ManagedServiceAccountRow): HomeAssistantManagedServiceAccount {
  return {
    id: serviceAccount.id,
    name: serviceAccount.name,
    tokenPrefix: serviceAccount.tokenPrefix,
    revokedAt: serviceAccount.revokedAt?.toISOString() ?? null,
    createdAt: serviceAccount.createdAt.toISOString(),
    updatedAt: serviceAccount.updatedAt.toISOString()
  }
}

async function ensureHomeAssistantAuthGroup(prisma: TenantScopedPrismaClient, tenantId: string): Promise<void> {
  await prisma.authGroup.upsert({
    where: {
      tenantId_key: {
        tenantId,
        key: HOME_ASSISTANT_AUTH_GROUP_KEY
      }
    },
    create: {
      tenantId,
      key: HOME_ASSISTANT_AUTH_GROUP_KEY,
      name: HOME_ASSISTANT_AUTH_GROUP_NAME,
      description: HOME_ASSISTANT_AUTH_GROUP_DESCRIPTION,
      permissions: HOME_ASSISTANT_RECOMMENDED_PERMISSIONS,
      isSystem: true,
      isEditable: false,
      isRemovable: false
    },
    update: {
      name: HOME_ASSISTANT_AUTH_GROUP_NAME,
      description: HOME_ASSISTANT_AUTH_GROUP_DESCRIPTION,
      permissions: HOME_ASSISTANT_RECOMMENDED_PERMISSIONS,
      isSystem: true,
      isEditable: false,
      isRemovable: false
    }
  })
}

function createServiceAccountToken(): string {
  return `bhs_${crypto.randomBytes(6).toString('hex')}_${crypto.randomBytes(24).toString('base64url')}`
}

function createServiceAccountTokenPrefix(token: string): string {
  const segments = token.split('_')
  const prefix = segments.length >= 2 ? `${segments[0]}_${segments[1]}` : token.slice(0, 16)
  return prefix.slice(0, 32)
}

function expandWithImpliedPermissions(permissions: readonly Permission[]): Permission[] {
  const expanded = new Set(permissions)
  for (const permission of resolveImpliedPermissions(permissions)) {
    expanded.add(permission)
  }
  return [...expanded]
}