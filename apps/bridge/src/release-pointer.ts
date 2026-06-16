/**
 * Bridge release pointer bookkeeping shared by the Docker launcher and the
 * bundle update driver: which staged release is active, pending-health-check
 * tracking with rollback to the previous pointer, and retention cleanup.
 *
 * Kept separate from `launcher.ts` because the launcher has run-as-script
 * behavior that must never be pulled into the standalone (SEA) bundle.
 */
import { access, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface ActiveBridgeReleasePointer {
  releasePath: string
  entrypoint: string
  activatedAt?: string
  confirmedAt?: string
  pendingHealthCheck?: boolean
}

export async function resolveActiveBridgeEntrypoint(releasesDir: string): Promise<string | null> {
  const pointer = await readActiveReleasePointer(releasesDir)
  if (!pointer) return null

  const releasePath = resolveSafeChildPath(releasesDir, pointer.releasePath)
  const entrypoint = resolveSafeChildPath(releasePath, pointer.entrypoint)
  await access(entrypoint)
  return entrypoint
}

export async function restorePreviousBridgeRelease(releasesDir: string): Promise<boolean> {
  const previousPath = path.join(releasesDir, 'previous.json')
  const currentPath = path.join(releasesDir, 'current.json')
  const previous = await readFile(previousPath, 'utf8').catch(() => null)
  if (!previous) return false
  await writeFile(currentPath, previous, 'utf8')
  return true
}

export async function isActiveBridgeReleasePendingHealthCheck(releasesDir: string): Promise<boolean> {
  return (await readActiveReleasePointer(releasesDir))?.pendingHealthCheck === true
}

export async function confirmActiveBridgeReleaseHealthy(releasesDir: string, version: string): Promise<boolean> {
  const currentPath = path.join(releasesDir, 'current.json')
  const pointer = await readActiveReleasePointer(releasesDir)
  if (!pointer || pointer.releasePath !== version || pointer.pendingHealthCheck !== true) return false
  await writeFile(currentPath, JSON.stringify({
    ...pointer,
    pendingHealthCheck: false,
    confirmedAt: new Date().toISOString()
  }, null, 2) + '\n', 'utf8')
  return true
}

export async function cleanupConfirmedBridgeReleases(input: {
  releasesDir: string
  retentionMs: number
  now?: Date
}): Promise<string[]> {
  const pointer = await readActiveReleasePointer(input.releasesDir)
  if (!pointer?.confirmedAt || pointer.pendingHealthCheck === true) return []
  const confirmedAt = Date.parse(pointer.confirmedAt)
  if (!Number.isFinite(confirmedAt)) return []
  const nowMs = input.now?.getTime() ?? Date.now()
  if (nowMs - confirmedAt < input.retentionMs) return []

  const removed: string[] = []
  const entries = await readdir(input.releasesDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.staging' || entry.name === pointer.releasePath) continue
    await rm(path.join(input.releasesDir, entry.name), { recursive: true, force: true })
    removed.push(entry.name)
  }
  if (removed.length > 0) {
    await rm(path.join(input.releasesDir, 'previous.json'), { force: true })
  }
  return removed
}

/**
 * Hold-back bookkeeping: when a build fails its post-update health check and
 * is rolled back, its fingerprint is recorded so the automatic updater does
 * not re-install it in a loop. The hold-back clears when the server's current
 * build changes or an operator forces an install.
 */
export async function recordHeldBackBridgeBuild(releasesDir: string, sourceFingerprint: string): Promise<void> {
  await writeFile(path.join(releasesDir, 'held-back.json'), JSON.stringify({
    sourceFingerprint,
    failedAt: new Date().toISOString()
  }, null, 2) + '\n', 'utf8')
}

export async function readHeldBackBridgeBuild(releasesDir: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(releasesDir, 'held-back.json'), 'utf8')) as { sourceFingerprint?: unknown }
    return typeof parsed.sourceFingerprint === 'string' ? parsed.sourceFingerprint : null
  } catch {
    return null
  }
}

export async function clearHeldBackBridgeBuild(releasesDir: string): Promise<void> {
  await rm(path.join(releasesDir, 'held-back.json'), { force: true })
}

export async function readActiveReleasePointer(releasesDir: string): Promise<ActiveBridgeReleasePointer | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(releasesDir, 'current.json'), 'utf8')) as Partial<ActiveBridgeReleasePointer>
    if (typeof parsed.releasePath !== 'string' || typeof parsed.entrypoint !== 'string') return null
    return {
      releasePath: parsed.releasePath,
      entrypoint: parsed.entrypoint,
      ...(typeof parsed.activatedAt === 'string' ? { activatedAt: parsed.activatedAt } : {}),
      ...(typeof parsed.confirmedAt === 'string' ? { confirmedAt: parsed.confirmedAt } : {}),
      ...(typeof parsed.pendingHealthCheck === 'boolean' ? { pendingHealthCheck: parsed.pendingHealthCheck } : {})
    }
  } catch {
    return null
  }
}

function resolveSafeChildPath(root: string, child: string): string {
  if (path.isAbsolute(child)) {
    throw new Error('Bridge release pointer cannot use absolute paths.')
  }
  const resolved = path.resolve(root, child)
  const normalizedRoot = path.resolve(root)
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error('Bridge release pointer cannot escape the releases directory.')
  }
  return resolved
}
