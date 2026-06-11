/**
 * Evaluates bridge app/protocol metadata against the server's known static
 * compatibility policy. Phase 1 is observe-and-warn only; bundle installation
 * is introduced by later phases.
 */
import {
  bridgeReleaseManifestSchema,
  bridgeReleaseSchema,
  type BridgeRelease,
  type BridgeReleaseManifest,
  type BridgeUpdateStatus,
  type BridgeUpdateSummary
} from '@printstream/shared'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { env } from './env.js'

const CURRENT_BRIDGE_VERSION = '0.1.0'
const CURRENT_BRIDGE_PROTOCOL_VERSION = 1
const CURRENT_RUNNER_ABI_VERSION = 'node22-ffmpeg7-v1'
const CURRENT_BRIDGE_BUILD_REVISION = normalizeOptionalBuildMetadata(env.PRINTSTREAM_BRIDGE_BUILD_REVISION)
const CURRENT_BRIDGE_SOURCE_FINGERPRINT = normalizeOptionalBuildMetadata(env.PRINTSTREAM_BRIDGE_SOURCE_FINGERPRINT)
const DEFAULT_UPDATE_CHANNEL = 'stable'
const STATIC_MANIFEST_GENERATED_AT = '2026-05-20T00:00:00.000Z'

interface BridgeVersionMetadata {
  version?: string | null
  buildRevision?: string | null
  sourceFingerprint?: string | null
  protocolVersion?: number | null
  runnerAbiVersion?: string | null
  updateChannel?: string | null
  updateStatus?: string | null
  latestAvailableVersion?: string | null
  lastUpdateCheckAt?: Date | null
  lastUpdateError?: string | null
}

interface BridgeReleaseChannelPolicy {
  latestVersion: string
  latestBuildRevision: string | null
  latestSourceFingerprint: string | null
  minimumSupportedProtocol: number
  minimumRecommendedVersion: string
  protocolVersion: number
  minimumRunnerAbiVersion: string
}

interface BridgeUpdateSummaryOptions {
  latestBuildRevision?: string | null
  latestSourceFingerprint?: string | null
}

const STATIC_BRIDGE_RELEASE_POLICY: Record<string, BridgeReleaseChannelPolicy> = {
  stable: {
    latestVersion: CURRENT_BRIDGE_VERSION,
    latestBuildRevision: CURRENT_BRIDGE_BUILD_REVISION,
    latestSourceFingerprint: CURRENT_BRIDGE_SOURCE_FINGERPRINT,
    minimumSupportedProtocol: CURRENT_BRIDGE_PROTOCOL_VERSION,
    minimumRecommendedVersion: CURRENT_BRIDGE_VERSION,
    protocolVersion: CURRENT_BRIDGE_PROTOCOL_VERSION,
    minimumRunnerAbiVersion: CURRENT_RUNNER_ABI_VERSION
  },
  beta: {
    latestVersion: CURRENT_BRIDGE_VERSION,
    latestBuildRevision: CURRENT_BRIDGE_BUILD_REVISION,
    latestSourceFingerprint: CURRENT_BRIDGE_SOURCE_FINGERPRINT,
    minimumSupportedProtocol: CURRENT_BRIDGE_PROTOCOL_VERSION,
    minimumRecommendedVersion: CURRENT_BRIDGE_VERSION,
    protocolVersion: CURRENT_BRIDGE_PROTOCOL_VERSION,
    minimumRunnerAbiVersion: CURRENT_RUNNER_ABI_VERSION
  }
}

export function buildBridgeUpdateSummary(bridge: BridgeVersionMetadata, options: BridgeUpdateSummaryOptions = {}): BridgeUpdateSummary {
  const channel = normalizeBridgeUpdateChannel(bridge.updateChannel)
  const policy = applyBridgeUpdateSummaryOptions(STATIC_BRIDGE_RELEASE_POLICY[channel], options)
  const status = resolveBridgeUpdateStatus(bridge, policy)

  return {
    status,
    currentVersion: bridge.version ?? null,
    latestVersion: policy?.latestVersion ?? bridge.latestAvailableVersion ?? null,
    currentBuildRevision: bridge.buildRevision ?? null,
    latestBuildRevision: policy?.latestBuildRevision ?? null,
    protocolVersion: bridge.protocolVersion ?? null,
    runnerAbiVersion: bridge.runnerAbiVersion ?? null,
    channel,
    lastCheckedAt: bridge.lastUpdateCheckAt?.toISOString() ?? null,
    lastError: bridge.lastUpdateError ?? null,
    manualUpdateCommand: resolveManualUpdateCommand(status)
  }
}

function applyBridgeUpdateSummaryOptions(
  policy: BridgeReleaseChannelPolicy | undefined,
  options: BridgeUpdateSummaryOptions
): BridgeReleaseChannelPolicy | undefined {
  if (!policy) return policy
  if (options.latestBuildRevision === undefined && options.latestSourceFingerprint === undefined) return policy
  return {
    ...policy,
    latestBuildRevision: options.latestBuildRevision === undefined ? policy.latestBuildRevision : options.latestBuildRevision,
    latestSourceFingerprint: options.latestSourceFingerprint === undefined ? policy.latestSourceFingerprint : options.latestSourceFingerprint
  }
}

export function getBridgeReleaseManifest(channel?: string, options: { releasesDir?: string } = {}): BridgeReleaseManifest {
  const normalizedChannel = channel ? normalizeBridgeUpdateChannel(channel) : null
  const publishedReleases = loadPublishedBridgeReleases(options.releasesDir ?? env.BRIDGE_RELEASES_DIR)
  const channelNames = new Set([
    ...Object.keys(STATIC_BRIDGE_RELEASE_POLICY),
    ...publishedReleases.keys()
  ])
  const channels = Object.fromEntries(
    [...channelNames]
      .filter((entryChannel) => normalizedChannel == null || entryChannel === normalizedChannel)
      .map((entryChannel) => {
        const policy = STATIC_BRIDGE_RELEASE_POLICY[entryChannel] ?? getDefaultBridgeReleasePolicy()
        const releasesByVersion = new Map<string, BridgeRelease>()
        releasesByVersion.set(policy.latestVersion, {
          version: policy.latestVersion,
          protocolVersion: policy.protocolVersion,
          runnerAbiVersion: policy.minimumRunnerAbiVersion,
          minimumRunnerAbiVersion: policy.minimumRunnerAbiVersion,
          releasedAt: STATIC_MANIFEST_GENERATED_AT,
          critical: false,
          notesUrl: null,
          bundle: null
        })
        for (const release of publishedReleases.get(entryChannel) ?? []) {
          releasesByVersion.set(release.version, release)
        }
        const releases = [...releasesByVersion.values()].sort((left, right) => compareVersion(right.version, left.version))
        return [entryChannel, {
          latestVersion: releases[0]?.version ?? policy.latestVersion,
          minimumSupportedProtocol: policy.minimumSupportedProtocol,
          minimumRecommendedVersion: policy.minimumRecommendedVersion,
          releases
        }]
      })
  )

  return bridgeReleaseManifestSchema.parse({
    schemaVersion: 1,
    generatedAt: STATIC_MANIFEST_GENERATED_AT,
    channels
  })
}

function getDefaultBridgeReleasePolicy(): BridgeReleaseChannelPolicy {
  const policy = STATIC_BRIDGE_RELEASE_POLICY.stable
  if (!policy) {
    throw new Error('Default bridge release policy is not configured.')
  }
  return policy
}

function loadPublishedBridgeReleases(releasesDir: string): Map<string, BridgeRelease[]> {
  const releases = new Map<string, BridgeRelease[]>()
  if (!existsSync(releasesDir)) return releases
  for (const filePath of listJsonFiles(releasesDir)) {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { channel?: unknown }
    const entryChannel = normalizeBridgeUpdateChannel(typeof raw.channel === 'string' ? raw.channel : null)
    const release = bridgeReleaseSchema.parse(raw)
    releases.set(entryChannel, [...(releases.get(entryChannel) ?? []), release])
  }
  return releases
}

function listJsonFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return listJsonFiles(entryPath)
    return entry.isFile() && entry.name.endsWith('.json') ? [entryPath] : []
  })
}

function resolveBridgeUpdateStatus(
  bridge: BridgeVersionMetadata,
  policy: BridgeReleaseChannelPolicy | undefined
): BridgeUpdateStatus {
  if (bridge.updateStatus === 'unsupported') {
    return bridge.updateStatus
  }
  if (!policy || !bridge.version || bridge.protocolVersion == null || !bridge.runnerAbiVersion) {
    return 'unknown'
  }
  if (bridge.protocolVersion < policy.minimumSupportedProtocol) {
    return 'updateRequired'
  }
  if (bridge.runnerAbiVersion !== policy.minimumRunnerAbiVersion) {
    return 'runnerUpdateRequired'
  }
  if (compareVersion(bridge.version, policy.minimumRecommendedVersion) < 0) {
    return 'updateRecommended'
  }
  if (compareVersion(bridge.version, policy.latestVersion) < 0) {
    return 'updateAvailable'
  }
  if (policy.latestSourceFingerprint && bridge.sourceFingerprint !== policy.latestSourceFingerprint) {
    return 'imageUpdateRequired'
  }
  return 'current'
}

function resolveManualUpdateCommand(status: BridgeUpdateStatus): string | null {
  if (status === 'runnerUpdateRequired') return 'docker compose pull bridge && docker compose up -d bridge'
  if (status === 'imageUpdateRequired') return 'docker compose build bridge && docker compose up -d bridge'
  return null
}

function normalizeBridgeUpdateChannel(channel: string | null | undefined): string {
  return channel && channel.trim() ? channel.trim() : DEFAULT_UPDATE_CHANNEL
}

function normalizeOptionalBuildMetadata(value: string | undefined): string | null {
  if (!value || value === 'unknown') return null
  return value
}

function compareVersion(left: string, right: string): number {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (delta !== 0) return delta > 0 ? 1 : -1
  }
  return 0
}

function parseVersion(version: string): number[] {
  return version.split(/[.-]/).map((part) => {
    const parsed = Number.parseInt(part, 10)
    return Number.isFinite(parsed) ? parsed : 0
  })
}