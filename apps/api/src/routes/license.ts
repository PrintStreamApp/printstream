/**
 * Self-hosted license management (core). Read the installed license status, and
 * — with `settings.manage` — install or remove a license key. Ships in OSS so
 * self-hosted operators can enter their commercial or community key; in the
 * multi-workspace cloud licensing is via subscriptions, so the key is simply unset.
 */
import {
  SETTINGS_MANAGE_PERMISSION,
  communityLicenseRequestSchema,
  type CommunityLicenseResponse,
  type LicenseCheckResponse,
  type LicenseStatusResponse,
  setLicenseRequestSchema
} from '@printstream/shared'
import { Router } from 'express'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { badRequest, conflict } from '../lib/http-error.js'
import { requestCommunityLicense } from '../lib/community-license-request-client.js'
import { getLicenseEnforcement, invalidateLicenseCache, isLicenseEnforced } from '../lib/license-enforcement.js'
import { refreshInstalledLicense } from '../lib/license-refresh-client.js'
import { clearInstalledLicenseKey, getInstalledLicenseStatus, setInstalledLicenseKey } from '../lib/license-state.js'
import { rootPrisma } from '../lib/prisma.js'

export const licenseRouter = Router()

/**
 * The full status payload, assembled once because three routes return it and a
 * fourth (`/check`) spreads it.
 *
 * `printerCount` is install-wide, matching what `printer-quota.ts` enforces the
 * cap against — a workspace-scoped count would understate the fleet on a
 * multi-workspace install and tell the add dialog the wrong thing about money.
 */
async function readLicenseStatusResponse(): Promise<LicenseStatusResponse> {
  const [status, enforcement, printerCount] = await Promise.all([
    getInstalledLicenseStatus(),
    getLicenseEnforcement(),
    // Only where a licence is actually enforced. This route is reachable
    // without a session (the licence banner renders pre-auth), and on the
    // multi-workspace cloud an install-wide count is the PLATFORM total —
    // handing that to an anonymous caller is a stats leak, and no cloud surface
    // reads the number anyway.
    isLicenseEnforced() ? rootPrisma.printer.count() : Promise.resolve(0)
  ])
  return { status, enforcement, printerCount }
}

licenseRouter.get('/', async (_request, response) => {
  response.json(await readLicenseStatusResponse())
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
  response.json(await readLicenseStatusResponse())
})

/**
 * Pull the current key from the vendor now, instead of waiting for the daily
 * timer. The operator reaches for this after changing their subscription, when
 * "it will sort itself out within a day" is not an acceptable answer.
 *
 * Deliberately NOT `/refresh`: the cloud deployment mounts its own public
 * `/api/license/refresh` (the endpoint self-hosted installs call), and two
 * routers on one path means whichever registered first silently wins.
 */
/**
 * Ask the vendor for a free community key, from an install with no account.
 *
 * Relayed by the server rather than called from the browser — see
 * `community-license-request-client.ts` for why. Gated on `settings.manage`
 * like installing a key: it names this machine's operator to a third party and
 * puts their address on a licence, which is not something any workspace member
 * should be able to do.
 *
 * The response says only that delivery was attempted. The vendor deliberately
 * does not report whether that address already had a key, and repeating that
 * discretion here costs nothing.
 */
licenseRouter.post('/community-request', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
  const parsed = communityLicenseRequestSchema.safeParse(request.body)
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Enter the email address to send the key to.')
  }
  annotateRequestAuditLog(request, {
    action: 'license.community-request',
    resource: 'license',
    summary: 'Requested a free community license key from the vendor',
    // The address the key was sent to, which is the whole of what was shared.
    metadata: { email: parsed.data.email.toLowerCase() }
  })
  const outcome = await requestCommunityLicense(parsed.data)
  if (!outcome.ok) {
    throw conflict(outcome.message)
  }
  const body: CommunityLicenseResponse = { delivered: true }
  response.status(202).json(body)
})

licenseRouter.post('/check', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (_request, response) => {
  // `userInitiated`: this route exists only because someone pressed "Refresh
  // license". That consent is what lets a perpetual Lifetime key contact the
  // vendor to collect a renewed updates window — the background timer stays
  // silent for it. See `license-refresh-client.ts`.
  const outcome = await refreshInstalledLicense({ userInitiated: true })
  const body: LicenseCheckResponse = { outcome, ...(await readLicenseStatusResponse()) }
  response.json(body)
})

licenseRouter.delete('/', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (_request, response) => {
  await clearInstalledLicenseKey()
  invalidateLicenseCache()
  response.status(204).end()
})
