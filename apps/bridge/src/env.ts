import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { OFFICIAL_BRIDGE_UPDATE_PUBLIC_KEY } from './update-trust.js'

const envModuleDir = path.dirname(fileURLToPath(import.meta.url))
const workspaceRoot = path.resolve(envModuleDir, '../../../')

loadDotenv({ path: path.join(workspaceRoot, '.env') })
loadDotenv()

interface BridgeBuildMetadataFile {
  bridgeBuildRevision?: unknown
  bridgeSourceFingerprint?: unknown
}

function readBridgeBuildMetadata() {
  try {
    const parsed = JSON.parse(readFileSync(path.join(workspaceRoot, 'bridge-build-metadata.json'), 'utf8')) as BridgeBuildMetadataFile
    return {
      buildRevision: typeof parsed.bridgeBuildRevision === 'string' && parsed.bridgeBuildRevision !== 'unknown'
        ? parsed.bridgeBuildRevision
        : undefined,
      sourceFingerprint: typeof parsed.bridgeSourceFingerprint === 'string' && parsed.bridgeSourceFingerprint !== 'unknown'
        ? parsed.bridgeSourceFingerprint
        : undefined
    }
  } catch {
    return {}
  }
}

const bridgeBuildMetadata = readBridgeBuildMetadata()

/**
 * The bridge version is a fact about the build, not operator config, so it is
 * sourced from this workspace's package.json rather than a hand-set env default.
 * Operators do not set BRIDGE_VERSION; the only legitimate override is the
 * launcher injecting an activated release bundle's manifest version (see
 * launcher.ts), which still flows through the env var below.
 */
function readBridgePackageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(path.join(workspaceRoot, 'apps/bridge/package.json'), 'utf8')) as { version?: unknown }
    if (typeof parsed.version === 'string' && parsed.version.trim()) return parsed.version.trim()
  } catch {
    // Fall through to a safe default if the package.json is missing/unreadable.
  }
  return '0.0.0'
}

const bridgePackageVersion = readBridgePackageVersion()

export function resolveWorkspacePath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(workspaceRoot, value)
}

const envSchema = z.object({
  BRIDGE_CLOUD_URL: z.string().url().default('http://api:4000'),
  BRIDGE_SIMULATOR_STATUS_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  DISCOVERY_PORT: z.coerce.number().int().positive().default(2021),
  BRIDGE_LIBRARY_DIR: z.string().default('/data/library'),
  BRIDGE_NAME: z.string().trim().min(1).max(120).default('PrintStream Bridge'),
  BRIDGE_STATE_FILE: z.string().default('/data/bridge-state.json'),
  BRIDGE_VERSION: z.string().trim().min(1).max(64).default(bridgePackageVersion),
  BRIDGE_BUILD_REVISION: z.string().trim().min(1).max(120).optional(),
  BRIDGE_SOURCE_FINGERPRINT: z.string().trim().min(1).max(120).optional(),
  BRIDGE_PROTOCOL_VERSION: z.coerce.number().int().nonnegative().default(1),
  BRIDGE_RUNNER_ABI_VERSION: z.string().trim().min(1).max(120).default('node22-ffmpeg7-v1'),
  BRIDGE_UPDATE_CHANNEL: z.enum(['stable', 'beta']).default('stable'),
  BRIDGE_AUTO_UPDATE: z.coerce.boolean().default(false),
  BRIDGE_RELEASES_DIR: z.string().default('/data/releases'),
  BRIDGE_RELEASE_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(7),
  BRIDGE_UPDATE_PUBLIC_KEY: z.string().trim().optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development')
})

const parsedEnv = envSchema.parse(process.env)

function normalizePemEnvValue(value: string | undefined): string | undefined {
  return value ? value.replace(/\\n/g, '\n') : value
}

export const env = {
  ...parsedEnv,
  BRIDGE_BUILD_REVISION: parsedEnv.BRIDGE_BUILD_REVISION ?? bridgeBuildMetadata.buildRevision,
  BRIDGE_SOURCE_FINGERPRINT: parsedEnv.BRIDGE_SOURCE_FINGERPRINT ?? bridgeBuildMetadata.sourceFingerprint,
  BRIDGE_LIBRARY_DIR: resolveWorkspacePath(parsedEnv.BRIDGE_LIBRARY_DIR),
  BRIDGE_STATE_FILE: resolveWorkspacePath(parsedEnv.BRIDGE_STATE_FILE),
  BRIDGE_RELEASES_DIR: resolveWorkspacePath(parsedEnv.BRIDGE_RELEASES_DIR),
  BRIDGE_UPDATE_PUBLIC_KEY: normalizePemEnvValue(parsedEnv.BRIDGE_UPDATE_PUBLIC_KEY) ?? OFFICIAL_BRIDGE_UPDATE_PUBLIC_KEY
}