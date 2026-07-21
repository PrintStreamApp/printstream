/**
 * Self-hosted license management (core). Read the installed license status, and
 * — with `settings.manage` — install or remove a license key. Ships in OSS so
 * self-hosted operators can enter their commercial or community key; in the
 * multi-tenant cloud licensing is via subscriptions, so the key is simply unset.
 */
import { SETTINGS_MANAGE_PERMISSION, type LicenseStatusResponse, setLicenseRequestSchema } from '@printstream/shared'
import { Router } from 'express'
import { requireRequestPermission } from '../lib/authorization.js'
import { badRequest } from '../lib/http-error.js'
import { getLicenseEnforcement, invalidateLicenseCache } from '../lib/license-enforcement.js'
import { clearInstalledLicenseKey, getInstalledLicenseStatus, setInstalledLicenseKey } from '../lib/license-state.js'

export const licenseRouter = Router()

licenseRouter.get('/', async (_request, response) => {
  const body: LicenseStatusResponse = {
    status: await getInstalledLicenseStatus(),
    enforcement: await getLicenseEnforcement()
  }
  response.json(body)
})

licenseRouter.put('/', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
  const parsed = setLicenseRequestSchema.safeParse(request.body)
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid license payload.')
  }
  const ok = await setInstalledLicenseKey(parsed.data.key)
  if (!ok) {
    throw badRequest('That license key is not valid.')
  }
  invalidateLicenseCache()
  const body: LicenseStatusResponse = {
    status: await getInstalledLicenseStatus(),
    enforcement: await getLicenseEnforcement()
  }
  response.json(body)
})

licenseRouter.delete('/', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (_request, response) => {
  await clearInstalledLicenseKey()
  invalidateLicenseCache()
  response.status(204).end()
})
