/**
 * Bridge build policy: bridges are lockstep with the server. Every build is
 * identified by a release fingerprint (content hash of the bridge-relevant
 * sources); the deploy promotes the server's own build by writing a pointer
 * file next to the published artifact fragments, the manifest announces that
 * build, and bridges whose fingerprint differs update to it. There are no
 * release versions — humans see build revisions and dates.
 */
import {
  bridgeBuildSchema,
  bridgeReleaseManifestSchema,
  type BridgeBuild,
  type BridgeReleaseBinary,
  type BridgeReleaseManifest,
  type BridgeUpdateStatus,
  type BridgeUpdateSummary
} from '@printstream/shared'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { isSelfHostedDeployment } from './deployment-mode.js'
import { env } from './env.js'

const CURRENT_BRIDGE_PROTOCOL_VERSION = 1
const DOCKER_RUNNER_ABI_VERSION = 'node22-ffmpeg7-v1'
const STANDALONE_RUNNER_ABI_VERSION = 'sea-node22-v1'
const SUPPORTED_RUNNER_ABI_VERSIONS = [DOCKER_RUNNER_ABI_VERSION, STANDALONE_RUNNER_ABI_VERSION]
/** Written by the deploy to promote the build matching the server checkout. */
export const CURRENT_BRIDGE_BUILD_POINTER_FILE = 'current-bridge-build.json'

const CURRENT_BRIDGE_SOURCE_FINGERPRINT = normalizeOptionalBuildMetadata(env.PRINTSTREAM_BRIDGE_SOURCE_FINGERPRINT)

/** Asset URLs under this path are rewritten to the origin serving the manifest. */
const RELEASE_ASSETS_PATH = '/api/bridge-runtime/release-assets/'

/**
 * Public origin to hand out in release-asset URLs: the instance's configured
 * `PUBLIC_BASE_URL` when set, else the origin the request arrived on. The
 * explicit setting matters behind proxy chains that hide the original
 * protocol (e.g. Cloudflare terminating TLS and reaching the origin over
 * plain HTTP) — bridges compare full origins, so `http://` vs `https://`
 * fails their same-origin download check.
 */
export function resolveBridgeAssetOrigin(requestOrigin: string | null): string | null {
  if (env.PUBLIC_BASE_URL) {
    try {
      return new URL(env.PUBLIC_BASE_URL).origin
    } catch {
      // Malformed configuration; fall back to the request origin.
    }
  }
  return requestOrigin
}

interface BridgeVersionMetadata {
  buildRevision?: string | null
  sourceFingerprint?: string | null
  releaseFingerprint?: string | null
  protocolVersion?: number | null
  runnerAbiVersion?: string | null
  updateStatus?: string | null
  lastUpdateCheckAt?: Date | null
  lastUpdateError?: string | null
}

interface CurrentBridgeBuildPointer {
  sourceFingerprint: string
  buildRevision: string | null
  promotedAt: string
}

export function getBridgeReleaseManifest(
  _channel?: string,
  options: { releasesDir?: string, assetOrigin?: string | null } = {}
): BridgeReleaseManifest {
  const releasesDir = options.releasesDir ?? env.BRIDGE_RELEASES_DIR
  const pointer = readCurrentBridgeBuildPointer(releasesDir)
  const current = pointer ? mergePublishedBuildFragments(releasesDir, pointer) : null

  return bridgeReleaseManifestSchema.parse({
    schemaVersion: 2,
    generatedAt: pointer?.promotedAt ?? new Date(0).toISOString(),
    minimumSupportedProtocol: CURRENT_BRIDGE_PROTOCOL_VERSION,
    current: current && options.assetOrigin ? rewriteBuildAssetOrigins(current, options.assetOrigin) : current
  })
}

/**
 * Points the build's release-asset URLs at the given origin (the one the
 * manifest request came in on). CI publishes one fragment set to every server
 * with a single baked base URL, but each server stores the assets itself and
 * bridges enforce that downloads are same-origin with their own server — so
 * every server must hand out its own URLs. Foreign-host URLs (not under the
 * release-assets route) pass through untouched.
 */
function rewriteBuildAssetOrigins(build: BridgeBuild, origin: string): BridgeBuild {
  const rewriteUrl = (value: string): string => {
    try {
      const parsed = new URL(value)
      if (!parsed.pathname.startsWith(RELEASE_ASSETS_PATH)) return value
      return new URL(parsed.pathname + parsed.search, origin).toString()
    } catch {
      return value
    }
  }
  const binaries = build.binaries
    ? Object.fromEntries(Object.entries(build.binaries).map(([platformKey, binary]) => [platformKey, {
        ...binary,
        url: rewriteUrl(binary.url),
        ...(binary.downloadUrl ? { downloadUrl: rewriteUrl(binary.downloadUrl) } : {})
      }]))
    : undefined
  return {
    ...build,
    bundle: build.bundle ? { ...build.bundle, url: rewriteUrl(build.bundle.url) } : build.bundle,
    ...(binaries ? { binaries } : {})
  }
}

export function buildBridgeUpdateSummary(bridge: BridgeVersionMetadata, options: { releasesDir?: string } = {}): BridgeUpdateSummary {
  const releasesDir = options.releasesDir ?? env.BRIDGE_RELEASES_DIR
  const pointer = readCurrentBridgeBuildPointer(releasesDir)
  const current = pointer ? mergePublishedBuildFragments(releasesDir, pointer) : null
  const status = resolveBridgeUpdateStatus(bridge, pointer)

  return {
    status,
    currentReleaseFingerprint: bridge.releaseFingerprint ?? null,
    latestReleaseFingerprint: pointer?.sourceFingerprint ?? null,
    currentBuildRevision: bridge.buildRevision ?? null,
    latestBuildRevision: pointer?.buildRevision ?? current?.buildRevision ?? null,
    latestReleasedAt: current?.releasedAt ?? pointer?.promotedAt ?? null,
    protocolVersion: bridge.protocolVersion ?? null,
    runnerAbiVersion: bridge.runnerAbiVersion ?? null,
    lastCheckedAt: bridge.lastUpdateCheckAt?.toISOString() ?? null,
    lastError: bridge.lastUpdateError ?? null,
    manualUpdateCommand: resolveManualUpdateCommand(status, bridge.runnerAbiVersion ?? null)
  }
}

function resolveBridgeUpdateStatus(
  bridge: BridgeVersionMetadata,
  pointer: CurrentBridgeBuildPointer | null
): BridgeUpdateStatus {
  // Self-hosted (OSS Docker stack and native SEA) ships the bridge inside the
  // application bundle, so it is lockstep with the server by construction and
  // cannot update independently — the whole bundle updates as a unit. The
  // release-pointer drift comparison below is a cloud-only concept (it drives
  // separately-installed home bridges that legitimately self-update), so a
  // bundled bridge is definitionally `current`. Reporting anything else would
  // surface a "Bridge needs updating" banner (with an update action the user
  // cannot apply) and can block printing via `assertBridgeAllowsPrinting`.
  if (isSelfHostedDeployment()) {
    return 'current'
  }
  if (bridge.updateStatus === 'unsupported') {
    return bridge.updateStatus
  }
  if (bridge.protocolVersion == null || !bridge.runnerAbiVersion) {
    return 'unknown'
  }
  if (bridge.protocolVersion < CURRENT_BRIDGE_PROTOCOL_VERSION) {
    return 'updateRequired'
  }
  if (!SUPPORTED_RUNNER_ABI_VERSIONS.includes(bridge.runnerAbiVersion)) {
    return 'runnerUpdateRequired'
  }
  if (!bridge.releaseFingerprint) {
    return 'unknown'
  }
  if (pointer && bridge.releaseFingerprint !== pointer.sourceFingerprint) {
    // The bridge reported a failed-and-held-back update; keep showing that
    // instead of a plain "update available" until the server build changes.
    return bridge.updateStatus === 'updateHeldBack' ? 'updateHeldBack' : 'updateAvailable'
  }
  // Source fingerprints describe the Docker runner image; standalone builds
  // carry no image to drift.
  if (!isStandaloneRunnerAbi(bridge.runnerAbiVersion) &&
    CURRENT_BRIDGE_SOURCE_FINGERPRINT && bridge.sourceFingerprint !== CURRENT_BRIDGE_SOURCE_FINGERPRINT) {
    return 'imageUpdateRequired'
  }
  return 'current'
}

function isStandaloneRunnerAbi(runnerAbiVersion: string | null | undefined): boolean {
  return runnerAbiVersion?.startsWith('sea-') === true
}

function resolveManualUpdateCommand(status: BridgeUpdateStatus, runnerAbiVersion: string | null): string | null {
  if (isStandaloneRunnerAbi(runnerAbiVersion)) {
    if (status === 'runnerUpdateRequired' || status === 'updateHeldBack') return 'printstream-bridge update apply'
    return null
  }
  if (status === 'runnerUpdateRequired') return 'docker compose pull bridge && docker compose up -d bridge'
  if (status === 'imageUpdateRequired') return 'docker compose build bridge && docker compose up -d bridge'
  return null
}

function readCurrentBridgeBuildPointer(releasesDir: string): CurrentBridgeBuildPointer | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(releasesDir, CURRENT_BRIDGE_BUILD_POINTER_FILE), 'utf8')) as Partial<CurrentBridgeBuildPointer>
    if (typeof parsed.sourceFingerprint !== 'string' || !parsed.sourceFingerprint) return null
    return {
      sourceFingerprint: parsed.sourceFingerprint,
      buildRevision: typeof parsed.buildRevision === 'string' ? parsed.buildRevision : null,
      promotedAt: typeof parsed.promotedAt === 'string' ? parsed.promotedAt : new Date(0).toISOString()
    }
  } catch {
    return null
  }
}

/**
 * A build's artifacts are published as `*.release.json` fragments; merge every
 * fragment matching the promoted fingerprint into the announced build. Returns
 * null when no artifacts for the promoted build have been published yet.
 *
 * Today only the standalone binary fragment is published (Docker bridges update
 * by image pull, so no app-bundle fragment exists). The merge stays general —
 * each fragment's ABI coordinates are pushed onto its own artifacts (`bundle` /
 * `binaries[*]`), and a bundle-carrying fragment, if one were ever present
 * again, would still supply the merged build's top-level coordinates.
 */
function mergePublishedBuildFragments(releasesDir: string, pointer: CurrentBridgeBuildPointer): BridgeBuild | null {
  let merged: BridgeBuild | null = null
  for (const filePath of listJsonFiles(releasesDir)) {
    if (path.basename(filePath) === CURRENT_BRIDGE_BUILD_POINTER_FILE) continue
    let fragment: BridgeBuild
    try {
      fragment = annotateArtifactAbi(bridgeBuildSchema.parse(JSON.parse(readFileSync(filePath, 'utf8'))))
    } catch {
      continue
    }
    if (fragment.sourceFingerprint !== pointer.sourceFingerprint) continue
    if (!merged) {
      merged = fragment
      continue
    }
    const binaries: Record<string, BridgeReleaseBinary> = { ...merged.binaries, ...fragment.binaries }
    const bundleFragment: BridgeBuild | null = fragment.bundle ? fragment : merged.bundle ? merged : null
    merged = {
      ...merged,
      ...fragment,
      bundle: fragment.bundle ?? merged.bundle,
      buildRevision: fragment.buildRevision ?? merged.buildRevision,
      ...(bundleFragment ? {
        runnerAbiVersion: bundleFragment.runnerAbiVersion,
        minimumRunnerAbiVersion: bundleFragment.minimumRunnerAbiVersion
      } : {}),
      ...(Object.keys(binaries).length > 0 ? { binaries } : {})
    }
  }
  return merged
}

/**
 * Backfills per-artifact ABI coordinates from the fragment's top-level ones
 * so already-published fragments (which predate the per-artifact fields)
 * merge correctly.
 */
function annotateArtifactAbi(fragment: BridgeBuild): BridgeBuild {
  const binaries = fragment.binaries
    ? Object.fromEntries(Object.entries(fragment.binaries).map(([platformKey, binary]) => [platformKey, {
        ...binary,
        minimumRunnerAbiVersion: binary.minimumRunnerAbiVersion ?? fragment.minimumRunnerAbiVersion
      }]))
    : undefined
  return {
    ...fragment,
    bundle: fragment.bundle
      ? { ...fragment.bundle, minimumRunnerAbiVersion: fragment.bundle.minimumRunnerAbiVersion ?? fragment.minimumRunnerAbiVersion }
      : fragment.bundle,
    ...(binaries ? { binaries } : {})
  }
}

function listJsonFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return listJsonFiles(entryPath)
    return entry.isFile() && entry.name.endsWith('.json') ? [entryPath] : []
  })
}

function normalizeOptionalBuildMetadata(value: string | undefined): string | null {
  if (!value || value === 'unknown') return null
  return value
}
