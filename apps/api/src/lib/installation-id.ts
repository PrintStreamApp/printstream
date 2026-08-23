/**
 * This installation's durable identity.
 *
 * A self-hosted licence covers ONE install, and enforcement counts that
 * install's printers, so without a stable way to say "which install", the same
 * key on two machines gives each the full entitlement. This is the id the
 * licence binds to on first refresh.
 *
 * Deliberately NOT derived from anything about the machine (hostname, MAC, disk
 * id): those change under a container rebuild, a move between hosts, or a
 * restore from backup, and a licence that unbinds itself every time the customer
 * redeploys is worse than no binding at all. Persisted instead, so it survives
 * exactly as long as the database does, the same reasoning as the bridge's own
 * `installationId` in `apps/bridge/src/state-store.ts`.
 *
 * **Treat it as a secret.** It is half of what claims a licence, so it is never
 * logged and never leaves the install except in the refresh request itself.
 *
 * Cloud deployments have one of these too and simply never use it: the cloud is
 * not a licensed install, so nothing asks.
 */
import crypto from 'node:crypto'
import { rootPrisma } from './prisma.js'

/** Platform-scoped, matching how other install-wide values are keyed. */
const INSTALLATION_ID_SETTING_KEY = 'platform:installation-id'

let cached: string | null = null

/**
 * The id, minting one on first call.
 *
 * Concurrent first calls are safe: the write is an upsert that ignores a
 * conflict, and whichever row lands is then read back, so every caller agrees
 * on one value rather than each keeping the id it generated.
 */
export async function getInstallationId(): Promise<string> {
  if (cached) return cached
  const minted = crypto.randomUUID()
  await rootPrisma.setting.upsert({
    where: { key: INSTALLATION_ID_SETTING_KEY },
    create: { key: INSTALLATION_ID_SETTING_KEY, value: minted },
    // Never overwrite: the first value wins for the life of the database, or a
    // restart would silently re-bind the licence to a "new" install.
    update: {}
  })
  const row = await rootPrisma.setting.findUnique({ where: { key: INSTALLATION_ID_SETTING_KEY } })
  cached = row?.value ?? minted
  return cached
}

/** Test seam: drops the memoised value so a fresh database is read again. */
export function resetInstallationIdCache(): void {
  cached = null
}
