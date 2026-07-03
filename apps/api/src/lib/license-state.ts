/**
 * Installed self-hosted license state (core). Reads/writes the license key from
 * the platform-scoped `Setting` store and derives its status. Used by the license
 * settings UI and the non-commercial banner. The key is stored install-wide (one
 * license per deployment); in the multi-tenant cloud, licensing is via
 * subscriptions and this is simply unset.
 */
import type { LicenseStatus } from '@printstream/shared'
import { readLicenseStatus, verifyLicenseToken } from './license.js'
import { rootPrisma } from './prisma.js'
import { scopeSettingKeyForTenant } from './tenant-settings.js'

const INSTALLED_LICENSE_KEY = scopeSettingKeyForTenant(null, 'license.installedKey')

export async function getInstalledLicenseKey(): Promise<string | null> {
  const row = await rootPrisma.setting.findUnique({ where: { key: INSTALLED_LICENSE_KEY } })
  return row?.value ?? null
}

export async function getInstalledLicenseStatus(): Promise<LicenseStatus> {
  return readLicenseStatus(await getInstalledLicenseKey())
}

/** Store a verified license key. Returns false when the key fails verification. */
export async function setInstalledLicenseKey(key: string): Promise<boolean> {
  const trimmed = key.trim()
  if (!verifyLicenseToken(trimmed)) return false
  await rootPrisma.setting.upsert({
    where: { key: INSTALLED_LICENSE_KEY },
    create: { key: INSTALLED_LICENSE_KEY, value: trimmed },
    update: { value: trimmed }
  })
  return true
}

export async function clearInstalledLicenseKey(): Promise<void> {
  await rootPrisma.setting.deleteMany({ where: { key: INSTALLED_LICENSE_KEY } })
}
