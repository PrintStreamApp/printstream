/**
 * Update driver for the slim Docker bridge image: when the server's current
 * build fingerprint differs from this bridge's, it downloads the signed
 * single-file app bundle and activates it under the bridge-owned releases
 * directory, where the launcher (`launcher-docker.ts`) picks it up on the next
 * start. Builds that failed their post-update health check are held back from
 * automatic retries until the server's build changes or an operator forces
 * the install.
 *
 * The bundle only ever installs onto a runner whose ABI matches the bundle's
 * EXACTLY — the image bakes the pinned Node version into
 * `BRIDGE_RUNNER_ABI_VERSION` (`node<version>-ffmpeg7-v1`), so new JS never
 * runs on a different Node than it was built for (a Node-patch behavior skew
 * broke H2D FTPS once; see nodejs/node#64402). An ABI mismatch reports
 * `runnerUpdateRequired`: pull a newer image, after which bundle updates
 * resume.
 */
import type { BridgeUpdateActionResult } from '@printstream/shared'
import { env } from './env.js'
import {
  cleanupConfirmedBridgeReleases,
  clearHeldBackBridgeBuild,
  confirmActiveBridgeReleaseHealthy,
  readHeldBackBridgeBuild
} from './release-pointer.js'
import { activateBridgeBundle, stageBridgeBundle, verifyBridgeBundleBytes } from './update-bundle-store.js'
import { resolveBridgeReleaseUrl } from './update-signing.js'
import {
  describeBridgeBuild,
  fetchCurrentBridgeBuild,
  shortBridgeFingerprint,
  type BridgeUpdateDriver,
  type BridgeUpdateInstallOptions
} from './update-driver.js'

export function createDockerBundleUpdateDriver(): BridgeUpdateDriver {
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
        return {
          accepted: false,
          status: 'updateAvailable',
          message: `Bridge build ${describeBridgeBuild(build)} is current on the server, but no app bundle is published yet. Update this Docker bridge by pulling a new image: docker compose pull && docker compose up -d.`
        }
      }

      const bundleUrl = resolveBridgeReleaseUrl(build.bundle.url, env.BRIDGE_SERVER_URL)
      const response = await fetch(bundleUrl)
      if (!response.ok) {
        return { accepted: false, status: 'updateAvailable', message: `Bridge update download failed with HTTP ${response.status}.` }
      }
      const verifiedBytes = verifyBridgeBundleBytes({
        release: build,
        downloadedBytes: Buffer.from(await response.arrayBuffer()),
        publicKeyPem: env.BRIDGE_UPDATE_PUBLIC_KEY
      })
      const stagedDir = await stageBridgeBundle({
        release: build,
        verifiedBytes,
        releasesDir: env.BRIDGE_RELEASES_DIR
      })
      await activateBridgeBundle({
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
      // Minimal retention: with the active release confirmed, nothing else on
      // disk has a purpose — prune immediately (steady state: one release).
      const removed = await cleanupConfirmedBridgeReleases(env.BRIDGE_RELEASES_DIR)
      if (removed.length > 0) {
        console.log(`Removed superseded bridge releases: ${removed.join(', ')}`)
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
      result: {
        accepted: false,
        status: 'runnerUpdateRequired',
        message: 'A newer bridge runner image is required: docker compose pull && docker compose up -d.'
      },
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
