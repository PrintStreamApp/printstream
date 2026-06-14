/**
 * Platform-managed tenant availability helpers.
 *
 * Disabled tenants remain in the directory for platform admins, but they
 * cannot be selected as an active workspace until re-enabled.
 */
import { rootPrisma, type AnyPrismaClient } from './prisma.js'
import { scopeSettingKeyForTenant } from './tenant-settings.js'

export const TENANT_DISABLED_SETTING_KEY = 'platform:tenantDisabled'

type TenantSummaryLike = {
  id: string
}

type SettingStore = Pick<AnyPrismaClient, 'setting'>

export async function listDisabledTenantIds(input: {
  tenantIds: readonly string[]
  prismaClient?: SettingStore
}): Promise<Set<string>> {
  if (input.tenantIds.length === 0) {
    return new Set<string>()
  }

  const prismaClient = input.prismaClient ?? rootPrisma
  const rows = await prismaClient.setting.findMany({
    where: {
      key: {
        in: input.tenantIds.map((tenantId) => tenantDisabledSettingKey(tenantId))
      },
      value: 'true'
    },
    select: { key: true }
  })

  return new Set(rows.map((row) => tenantIdFromTenantDisabledSettingKey(row.key)).filter((tenantId): tenantId is string => tenantId != null))
}

export async function isTenantDisabled(input: {
  tenantId: string
  prismaClient?: SettingStore
}): Promise<boolean> {
  const prismaClient = input.prismaClient ?? rootPrisma
  const row = await prismaClient.setting.findUnique({
    where: { key: tenantDisabledSettingKey(input.tenantId) },
    select: { value: true }
  })

  return row?.value === 'true'
}

export async function setTenantDisabled(input: {
  tenantId: string
  disabled: boolean
  prismaClient?: SettingStore
}): Promise<void> {
  const prismaClient = input.prismaClient ?? rootPrisma
  await prismaClient.setting.upsert({
    where: { key: tenantDisabledSettingKey(input.tenantId) },
    update: { value: input.disabled ? 'true' : 'false' },
    create: {
      key: tenantDisabledSettingKey(input.tenantId),
      value: input.disabled ? 'true' : 'false'
    }
  })
}

export async function filterEnabledTenants<TTenant extends TenantSummaryLike>(input: {
  tenants: readonly TTenant[]
  prismaClient?: SettingStore
}): Promise<TTenant[]> {
  const disabledIds = await listDisabledTenantIds({
    tenantIds: input.tenants.map((tenant) => tenant.id),
    prismaClient: input.prismaClient
  })

  return input.tenants.filter((tenant) => !disabledIds.has(tenant.id))
}

export function tenantDisabledSettingKey(tenantId: string): string {
  return scopeSettingKeyForTenant(tenantId, TENANT_DISABLED_SETTING_KEY)
}

function tenantIdFromTenantDisabledSettingKey(key: string): string | null {
  const prefix = 'tenant:'
  const suffix = `:${TENANT_DISABLED_SETTING_KEY}`
  if (!key.startsWith(prefix) || !key.endsWith(suffix)) {
    return null
  }

  return key.slice(prefix.length, -suffix.length)
}