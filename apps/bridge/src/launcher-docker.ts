/**
 * Docker bridge launcher (slim-image entrypoint).
 *
 * Starts a signed single-file app bundle from the bridge-owned releases
 * directory when one is activated, otherwise falls back to the image-baked
 * runner (`/app/bridge-runner.cjs`). If an activated bundle dies before its
 * post-update health check clears, the launcher records the failed
 * fingerprint as held back, restores the previous release pointer, and
 * retries once — the same crash-rollback semantics as the SEA self-updater.
 *
 * This is the FIXED POINT of the bundle self-update scheme: the launcher only
 * ships with the image and is never self-updated, so it must stay tiny,
 * dependency-free, and read env directly (importing `env.ts` would drag the
 * whole config surface into the file that has to outlive every bundle).
 *
 * This module self-executes when bundled as a script; it must never be
 * imported by runtime code (the pointer helpers it needs live in
 * `release-pointer.ts` for that reason).
 */
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import {
  isActiveBridgeReleasePendingHealthCheck,
  recordHeldBackBridgeBuild,
  resolveActiveBridgeEntrypoint,
  restorePreviousBridgeRelease
} from './release-pointer.js'

const releasesDir = process.env.BRIDGE_RELEASES_DIR?.trim() || '/data/releases'
const fallbackEntrypoint = process.env.BRIDGE_LAUNCHER_FALLBACK_ENTRYPOINT?.trim() || '/app/bridge-runner.cjs'

async function main(): Promise<void> {
  let rollbackAttempted = false
  while (true) {
    const activeEntrypoint = await resolveActiveBridgeEntrypoint(releasesDir).catch((error) => {
      console.warn(`Ignoring active bridge release pointer: ${(error as Error).message}`)
      return null
    })
    const entrypoint = activeEntrypoint ?? fallbackEntrypoint
    const releaseEnv = activeEntrypoint ? await readActiveBridgeReleaseEnv(activeEntrypoint) : {}
    const result = await runBridgeEntrypoint(entrypoint, releaseEnv)
    if (result.signal) {
      process.kill(process.pid, result.signal)
      return
    }
    if (activeEntrypoint && result.code !== 0 && !rollbackAttempted && await isActiveBridgeReleasePendingHealthCheck(releasesDir)) {
      // Hold the failed build back before restoring the previous pointer so
      // the automatic updater does not immediately re-install it in a loop.
      const failedFingerprint = releaseEnv.BRIDGE_RELEASE_FINGERPRINT
      if (failedFingerprint) {
        await recordHeldBackBridgeBuild(releasesDir, failedFingerprint).catch(() => undefined)
      }
      if (await restorePreviousBridgeRelease(releasesDir)) {
        rollbackAttempted = true
        console.warn('Bridge release failed before health confirmation; restored previous release pointer and retrying once.')
        continue
      }
    }
    process.exit(result.code ?? 0)
  }
}

/**
 * Identity env injected into an activated bundle, read from the release's
 * `manifest.json`. The image-drift fingerprint stays whatever the image env
 * carries (it describes the runner image, which only the launcher — running
 * from the image — can vouch for; a bundle has no image metadata of its own).
 */
async function readActiveBridgeReleaseEnv(entrypoint: string): Promise<Record<string, string>> {
  const relative = path.relative(path.resolve(releasesDir), entrypoint)
  const [releasePath] = relative.split(path.sep)
  if (!releasePath || releasePath.startsWith('..')) return {}
  const manifest = await readFile(path.join(releasesDir, releasePath, 'manifest.json'), 'utf8')
    .then((raw) => JSON.parse(raw) as { sourceFingerprint?: unknown; buildRevision?: unknown; protocolVersion?: unknown; runnerAbiVersion?: unknown })
    .catch(() => null)
  if (!manifest) return {}

  return {
    ...(typeof manifest.sourceFingerprint === 'string' ? { BRIDGE_RELEASE_FINGERPRINT: manifest.sourceFingerprint } : {}),
    ...(typeof manifest.buildRevision === 'string' ? { BRIDGE_BUILD_REVISION: manifest.buildRevision } : {})
    // Deliberately NOT the manifest's runnerAbiVersion: the ABI describes the
    // RUNNER (this image), not the bundle, and the image env already carries it.
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

void main().catch((error) => {
  console.error('Bridge launcher failed', error)
  process.exit(1)
})
