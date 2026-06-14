/**
 * Update driver for Docker/launcher installs: when the server's current build
 * fingerprint differs from this bridge's, it downloads the signed app bundle
 * and activates it under the bridge-owned releases directory, where the
 * launcher (`launcher.ts`) picks it up on the next start. Builds that failed
 * their post-update health check are held back from automatic retries until
 * the server's build changes or an operator forces the install.
 */
import type { BridgeUpdateActionResult } from '@printstream/shared'
import { env } from './env.js'
import { activateBridgeRelease, resolveBridgeReleaseUrl, stageBridgeReleaseBundle } from './update-bundles.js'
import {
  cleanupConfirmedBridgeReleases,
  clearHeldBackBridgeBuild,
  confirmActiveBridgeReleaseHealthy,
  readHeldBackBridgeBuild
} from './release-pointer.js'
import {
  describeBridgeBuild,
  fetchCurrentBridgeBuild,
  shortBridgeFingerprint,
  type BridgeUpdateDriver,
  type BridgeUpdateInstallOptions
} from './update-driver.js'

export function createBundleUpdateDriver(): BridgeUpdateDriver {
  return {
    async check(): Promise<BridgeUpdateActionResult> {
      const evaluation = await evaluateCurrentBuild()
      return evaluation.result
    },

    async install(options: BridgeUpdateInstallOptions = {}): Promise<BridgeUpdateActionResult> {
      const evaluation = await evaluateCurrentBuild(options)
      if (!evaluation.installable || !evaluation.build) {
        return evaluation.result
      }
      const build = evaluation.build
      if (!build.bundle) {
        return { accepted: false, status: 'updateAvailable', message: `Bridge build ${describeBridgeBuild(build)} is current on the server, but no app bundle is published yet.` }
      }

      const bundleUrl = resolveBridgeReleaseUrl(build.bundle.url, env.BRIDGE_SERVER_URL)
      const response = await fetch(bundleUrl)
      if (!response.ok) {
        return { accepted: false, status: 'updateAvailable', message: `Bridge update download failed with HTTP ${response.status}.` }
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      const stagedDir = await stageBridgeReleaseBundle({
        release: build,
        bytes,
        publicKeyPem: env.BRIDGE_UPDATE_PUBLIC_KEY,
        releasesDir: env.BRIDGE_RELEASES_DIR
      })
      await activateBridgeRelease({
        releaseDirName: shortBridgeFingerprint(build.sourceFingerprint),
        releasesDir: env.BRIDGE_RELEASES_DIR,
        stagedDir
      })
      if (options.ignoreHoldBack) {
        await clearHeldBackBridgeBuild(env.BRIDGE_RELEASES_DIR)
      }
      return { accepted: true, status: 'updateAvailable', message: `Bridge build ${describeBridgeBuild(build)} installed. Restarting bridge to activate it.` }
    },

    async confirmHealthy(): Promise<void> {
      const ownFingerprint = env.BRIDGE_RELEASE_FINGERPRINT
      if (ownFingerprint && await confirmActiveBridgeReleaseHealthy(env.BRIDGE_RELEASES_DIR, shortBridgeFingerprint(ownFingerprint))) {
        console.log(`Bridge build ${env.BRIDGE_BUILD_REVISION ?? shortBridgeFingerprint(ownFingerprint)} confirmed healthy.`)
      }
      const removed = await cleanupConfirmedBridgeReleases({
        releasesDir: env.BRIDGE_RELEASES_DIR,
        retentionMs: env.BRIDGE_RELEASE_RETENTION_DAYS * 24 * 60 * 60 * 1000
      })
      if (removed.length > 0) {
        console.log(`Removed old bridge releases: ${removed.join(', ')}`)
      }
    }
  }
}

async function evaluateCurrentBuild(options: BridgeUpdateInstallOptions = {}): Promise<{
  result: BridgeUpdateActionResult
  installable: boolean
  build: Awaited<ReturnType<typeof fetchCurrentBridgeBuild>>
}> {
  const ownFingerprint = env.BRIDGE_RELEASE_FINGERPRINT
  if (!ownFingerprint) {
    return {
      result: { accepted: false, status: 'unknown', message: 'This bridge build has no release fingerprint; updates are disabled.' },
      installable: false,
      build: null
    }
  }

  const build = await fetchCurrentBridgeBuild(env.BRIDGE_SERVER_URL)
  if (!build) {
    return {
      result: { accepted: false, status: 'unknown', message: 'The server has not promoted a bridge build yet.' },
      installable: false,
      build
    }
  }
  // The app bundle carries its own ABI requirement; the build's top-level
  // coordinate is a fallback for fragments that predate per-artifact ABI.
  // The merged manifest also lists standalone binaries with a different
  // runner family, so never gate this driver on those.
  const requiredAbi = build.bundle?.minimumRunnerAbiVersion ?? build.minimumRunnerAbiVersion
  if (requiredAbi !== env.BRIDGE_RUNNER_ABI_VERSION) {
    return {
      result: { accepted: false, status: 'runnerUpdateRequired', message: 'A newer bridge runner image is required.' },
      installable: false,
      build
    }
  }
  if (build.sourceFingerprint === ownFingerprint) {
    await clearStaleHoldBack(build.sourceFingerprint)
    return {
      result: { accepted: false, status: 'current', message: 'Bridge matches the server build.' },
      installable: false,
      build
    }
  }

  const heldBack = await readHeldBackBridgeBuild(env.BRIDGE_RELEASES_DIR)
  if (heldBack && heldBack !== build.sourceFingerprint) {
    // The server moved on from the failed build; retry normally again.
    await clearHeldBackBridgeBuild(env.BRIDGE_RELEASES_DIR)
  } else if (heldBack === build.sourceFingerprint && !options.ignoreHoldBack) {
    return {
      result: {
        accepted: false,
        status: 'updateHeldBack',
        message: `Bridge build ${describeBridgeBuild(build)} failed its health check and is held back; it retries when the server build changes or an update is started manually.`
      },
      installable: false,
      build
    }
  }

  return {
    result: { accepted: false, status: 'updateAvailable', message: `Bridge build ${describeBridgeBuild(build)} is available.` },
    installable: true,
    build
  }
}

async function clearStaleHoldBack(currentFingerprint: string): Promise<void> {
  const heldBack = await readHeldBackBridgeBuild(env.BRIDGE_RELEASES_DIR)
  if (heldBack && heldBack !== currentFingerprint) {
    await clearHeldBackBridgeBuild(env.BRIDGE_RELEASES_DIR)
  }
}
