/**
 * Bridge runner launcher (Docker entrypoint).
 *
 * Starts a signed app bundle from the bridge-owned releases directory when one
 * is activated, otherwise falls back to the image-bundled runtime entrypoint.
 *
 * This module self-executes when run as a script, so it must never be imported
 * into the standalone (SEA) bundle — the release pointer helpers it relies on
 * live in `release-pointer.ts` for that reason.
 */
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from './env.js'
import {
  isActiveBridgeReleasePendingHealthCheck,
  recordHeldBackBridgeBuild,
  resolveActiveBridgeEntrypoint,
  restorePreviousBridgeRelease
} from './release-pointer.js'

export {
  cleanupConfirmedBridgeReleases,
  confirmActiveBridgeReleaseHealthy,
  isActiveBridgeReleasePendingHealthCheck,
  resolveActiveBridgeEntrypoint,
  restorePreviousBridgeRelease
} from './release-pointer.js'

async function main(): Promise<void> {
  let rollbackAttempted = false
  while (true) {
    const activeEntrypoint = await resolveActiveBridgeEntrypoint(env.BRIDGE_RELEASES_DIR).catch((error) => {
      console.warn(`Ignoring active bridge release pointer: ${(error as Error).message}`)
      return null
    })
    const fallbackEntrypoint = fileURLToPath(new URL('./index.js', import.meta.url))
    const entrypoint = activeEntrypoint ?? fallbackEntrypoint
    const result = await runBridgeEntrypoint(entrypoint, activeEntrypoint ? await readActiveBridgeReleaseEnv(env.BRIDGE_RELEASES_DIR, activeEntrypoint) : {})
    if (result.signal) {
      process.kill(process.pid, result.signal)
      return
    }
    if (activeEntrypoint && result.code !== 0 && !rollbackAttempted && await isActiveBridgeReleasePendingHealthCheck(env.BRIDGE_RELEASES_DIR)) {
      // Hold the failed build back before restoring the previous pointer so
      // the automatic updater does not immediately re-install it in a loop.
      const failedFingerprint = (await readActiveBridgeReleaseEnv(env.BRIDGE_RELEASES_DIR, activeEntrypoint)).BRIDGE_RELEASE_FINGERPRINT
      if (failedFingerprint) {
        await recordHeldBackBridgeBuild(env.BRIDGE_RELEASES_DIR, failedFingerprint).catch(() => undefined)
      }
      if (await restorePreviousBridgeRelease(env.BRIDGE_RELEASES_DIR)) {
        rollbackAttempted = true
        console.warn('Bridge release failed before health confirmation; restored previous release pointer and retrying once.')
        continue
      }
    }
    process.exit(result.code ?? 0)
  }
}

async function readActiveBridgeReleaseEnv(releasesDir: string, entrypoint: string): Promise<Record<string, string>> {
  const relative = path.relative(path.resolve(releasesDir), entrypoint)
  const [releasePath] = relative.split(path.sep)
  if (!releasePath || releasePath.startsWith('..')) return {}
  const manifest = await readFile(path.join(releasesDir, releasePath, 'manifest.json'), 'utf8')
    .then((raw) => JSON.parse(raw) as { sourceFingerprint?: unknown; buildRevision?: unknown; protocolVersion?: unknown; runnerAbiVersion?: unknown })
    .catch(() => null)
  if (!manifest) return {}

  return {
    ...(typeof manifest.sourceFingerprint === 'string' ? { BRIDGE_RELEASE_FINGERPRINT: manifest.sourceFingerprint } : {}),
    ...(typeof manifest.buildRevision === 'string' ? { BRIDGE_BUILD_REVISION: manifest.buildRevision } : {}),
    ...(typeof manifest.protocolVersion === 'number' ? { BRIDGE_PROTOCOL_VERSION: String(manifest.protocolVersion) } : {}),
    ...(typeof manifest.runnerAbiVersion === 'string' ? { BRIDGE_RUNNER_ABI_VERSION: manifest.runnerAbiVersion } : {}),
    // The image-drift fingerprint describes the runner image, which only the
    // launcher (running from the image, next to its metadata file) can see;
    // an activated bundle has no metadata file of its own.
    ...(env.BRIDGE_SOURCE_FINGERPRINT ? { BRIDGE_SOURCE_FINGERPRINT: env.BRIDGE_SOURCE_FINGERPRINT } : {})
  }
}

function runBridgeEntrypoint(entrypoint: string, extraEnv: Record<string, string>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const child = spawn(process.execPath, [entrypoint], {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv }
  })
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error('Bridge launcher failed', error)
    process.exit(1)
  })
}
