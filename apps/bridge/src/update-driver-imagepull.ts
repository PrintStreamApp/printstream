/**
 * Update driver for Docker installs. Docker bridges update by pulling a newer
 * image (`docker compose pull && docker compose up -d`), not in place: there is
 * no launcher, releases directory, or signed app bundle. This driver therefore
 * only *reports* whether the server has moved to a different build — the passive
 * out-of-sync / image-update status the API already derives from the bridge's
 * reported fingerprint covers the rest — and tells operators to pull when an
 * install is requested.
 *
 * The standalone (SEA) packaging keeps its in-place self-updater
 * (`src/private/sea/self-update.ts`); only the Docker path is image-pull.
 */
import type { BridgeUpdateActionResult } from '@printstream/shared'
import { env } from './env.js'
import {
  describeBridgeBuild,
  fetchCurrentBridgeBuild,
  type BridgeUpdateDriver
} from './update-driver.js'

const PULL_HINT = 'docker compose pull && docker compose up -d'

export function createImagePullUpdateDriver(): BridgeUpdateDriver {
  return {
    async check(): Promise<BridgeUpdateActionResult> {
      return evaluateCurrentBuild()
    },

    async install(): Promise<BridgeUpdateActionResult> {
      const result = await evaluateCurrentBuild()
      // Docker bridges cannot self-apply; surface the manual step instead of a
      // restart. `accepted` stays false so the runtime never schedules one.
      if (result.status === 'updateAvailable') {
        return { accepted: false, status: 'updateAvailable', message: `A newer bridge build is available. Update this Docker bridge by pulling a new image: ${PULL_HINT}.` }
      }
      return result
    },

    async confirmHealthy(): Promise<void> {
      // No in-place updates to confirm or roll back.
    }
  }
}

async function evaluateCurrentBuild(): Promise<BridgeUpdateActionResult> {
  const ownFingerprint = env.BRIDGE_RELEASE_FINGERPRINT
  if (!ownFingerprint) {
    return { accepted: false, status: 'unknown', message: 'This bridge build has no release fingerprint; updates are disabled.' }
  }

  const build = await fetchCurrentBridgeBuild(env.BRIDGE_SERVER_URL)
  if (!build) {
    return { accepted: false, status: 'unknown', message: 'The server has not promoted a bridge build yet.' }
  }
  // Status is purely fingerprint-based here; the server's update policy
  // (apps/api/src/lib/bridge-update-policy.ts) is authoritative for the richer
  // protocol/ABI gating it shows in Settings. Either way the remedy is the same
  // for a Docker bridge: pull a newer image.
  if (build.sourceFingerprint === ownFingerprint) {
    return { accepted: false, status: 'current', message: 'Bridge matches the server build.' }
  }
  return { accepted: false, status: 'updateAvailable', message: `Bridge build ${describeBridgeBuild(build)} is available.` }
}
