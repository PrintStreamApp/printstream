/**
 * Bridge self-update abstraction.
 *
 * Bridges have no release versions: every build is identified by its release
 * fingerprint (a content hash over the bridge-relevant sources), the server's
 * manifest announces the build the server itself runs, and bridges converge to
 * it whenever their own fingerprint differs — including downgrades after a
 * server rollback (lockstep). How an update is obtained and applied depends on
 * packaging: Docker installs swap signed app bundles under the releases
 * directory, standalone installs replace their own binary in place. Each
 * packaging owns a driver; the runtime stays packaging-agnostic.
 */
import { bridgeReleaseManifestSchema, type BridgeBuild, type BridgeUpdateActionResult } from '@printstream/shared'

export interface BridgeUpdateInstallOptions {
  /**
   * Apply the update even when its fingerprint is held back after a failed
   * health check. Set for operator-initiated installs (cloud RPC, CLI); the
   * automatic updater leaves held-back builds alone until the server's
   * current build changes.
   */
  ignoreHoldBack?: boolean
}

export interface BridgeUpdateDriver {
  /** Report whether the server's current build differs from this bridge. */
  check(): Promise<BridgeUpdateActionResult>
  /**
   * Download, verify, and stage/apply the server's current build. When the
   * result is `accepted`, the runtime schedules a process restart.
   */
  install(options?: BridgeUpdateInstallOptions): Promise<BridgeUpdateActionResult>
  /**
   * Called once the bridge registers successfully after a (re)start so the
   * driver can mark a pending update healthy and clean up rollback artifacts.
   */
  confirmHealthy(): Promise<void>
}

/** Fetches the server's announced current bridge build (null until promoted). */
export async function fetchCurrentBridgeBuild(serverUrl: string): Promise<BridgeBuild | null> {
  const manifestResponse = await fetch(new URL('/api/bridge-runtime/releases', serverUrl))
  if (!manifestResponse.ok) {
    throw new Error(`Bridge release manifest request failed with HTTP ${manifestResponse.status}`)
  }
  return bridgeReleaseManifestSchema.parse(await manifestResponse.json()).current
}

/** Human-readable short form used for release directory names and messages. */
export function shortBridgeFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 12)
}

/** Label shown to humans for a build: git revision when known, else short hash. */
export function describeBridgeBuild(build: Pick<BridgeBuild, 'sourceFingerprint' | 'buildRevision'>): string {
  return build.buildRevision ?? shortBridgeFingerprint(build.sourceFingerprint)
}
