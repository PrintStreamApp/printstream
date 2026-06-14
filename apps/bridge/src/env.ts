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
  bridgeReleaseFingerprint?: unknown
}

function readBridgeBuildMetadata() {
  // Module root first (the build that shipped this code), then cwd: an
  // activated app bundle runs from the releases dir, which carries no
  // metadata file, while the runner image's copy sits in the working
  // directory. The launcher's injected BRIDGE_* env vars still win over
  // anything read here, so the bundle's own release identity is never
  // overwritten by the image file.
  for (const directory of [workspaceRoot, process.cwd()]) {
    let parsed: BridgeBuildMetadataFile
    try {
      parsed = JSON.parse(readFileSync(path.join(directory, 'bridge-build-metadata.json'), 'utf8')) as BridgeBuildMetadataFile
    } catch {
      continue
    }
    return {
      buildRevision: typeof parsed.bridgeBuildRevision === 'string' && parsed.bridgeBuildRevision !== 'unknown'
        ? parsed.bridgeBuildRevision
        : undefined,
      sourceFingerprint: typeof parsed.bridgeSourceFingerprint === 'string' && parsed.bridgeSourceFingerprint !== 'unknown'
        ? parsed.bridgeSourceFingerprint
        : undefined,
      releaseFingerprint: typeof parsed.bridgeReleaseFingerprint === 'string' && parsed.bridgeReleaseFingerprint !== 'unknown'
        ? parsed.bridgeReleaseFingerprint
        : undefined
    }
  }
  return {}
}

const bridgeBuildMetadata = readBridgeBuildMetadata()

export function resolveWorkspacePath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(workspaceRoot, value)
}

const envSchema = z.object({
  // Canonical name for the PrintStream server origin. `BRIDGE_CLOUD_URL` is
  // the legacy alias and keeps working so existing installs are unaffected.
  BRIDGE_SERVER_URL: z.preprocess(
    (value) => value ?? process.env.BRIDGE_CLOUD_URL,
    z.string().url().default('http://api:4000')
  ),
  BRIDGE_SIMULATOR_STATUS_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  DISCOVERY_PORT: z.coerce.number().int().positive().default(2021),
  BRIDGE_LIBRARY_DIR: z.string().default('/data/library'),
  BRIDGE_NAME: z.string().trim().min(1).max(120).default('PrintStream Bridge'),
  // Path to the managed-bridge provisioning token, shared with the API over a
  // mounted volume. When this file is present the bridge reads it and presents
  // the token at registration so the managed server auto-pairs it into the sole
  // workspace — no connect-code step. Absent for cloud and remote-bridge
  // installs, which pair by hand.
  MANAGED_BRIDGE_TOKEN_FILE: z.string().default('/run/provision/managed-bridge-token'),
  BRIDGE_STATE_FILE: z.string().default('/data/bridge-state.json'),
  BRIDGE_BUILD_REVISION: z.string().trim().min(1).max(120).optional(),
  BRIDGE_SOURCE_FINGERPRINT: z.string().trim().min(1).max(120).optional(),
  // Content hash identifying this build for lockstep updates; bridges update
  // whenever it stops matching the server's current build. Baked at build
  // time (Docker metadata file / SEA define); 'unknown' disables updates.
  BRIDGE_RELEASE_FINGERPRINT: z.string().trim().min(1).max(120).optional(),
  BRIDGE_PROTOCOL_VERSION: z.coerce.number().int().nonnegative().default(1),
  BRIDGE_RUNNER_ABI_VERSION: z.string().trim().min(1).max(120).default('node22-ffmpeg7-v1'),
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
  BRIDGE_RELEASE_FINGERPRINT: parsedEnv.BRIDGE_RELEASE_FINGERPRINT ?? bridgeBuildMetadata.releaseFingerprint,
  BRIDGE_LIBRARY_DIR: resolveWorkspacePath(parsedEnv.BRIDGE_LIBRARY_DIR),
  BRIDGE_STATE_FILE: resolveWorkspacePath(parsedEnv.BRIDGE_STATE_FILE),
  BRIDGE_RELEASES_DIR: resolveWorkspacePath(parsedEnv.BRIDGE_RELEASES_DIR),
  BRIDGE_UPDATE_PUBLIC_KEY: normalizePemEnvValue(parsedEnv.BRIDGE_UPDATE_PUBLIC_KEY) ?? OFFICIAL_BRIDGE_UPDATE_PUBLIC_KEY
}