/**
 * Bridge environment configuration.
 *
 * Loads `.env`, validates `process.env` with Zod, and exports the resolved `env`
 * (relative data paths resolved against the workspace root, PEM newlines
 * un-escaped). Build identity (revision/fingerprints) falls back to
 * `bridge-build-metadata.json`, but injected `BRIDGE_*` env vars always win so a
 * shipped bundle's release identity is never overwritten by the runner image.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { OFFICIAL_BRIDGE_UPDATE_PUBLIC_KEY } from './update-trust.js'
import { bridgeUpdateModeSchema, resolveBridgeUpdateMode } from './update-mode.js'

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

/** Parse explicit environment booleans without treating the string `false` as truthy. */
/** Treats an empty or whitespace value as unset, which is what `VAR: ${VAR:-}` in compose passes. */
function blankAsUnset<Schema extends z.ZodTypeAny>(schema: Schema) {
  return z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), schema)
}

/** A boolean that may be left unset, so a deprecated name can be told apart from its default. */
function optionalBooleanEnv() {
  return blankAsUnset(
    z.preprocess(
      (value) => typeof value === 'string' ? value.trim().toLowerCase() : value,
      z.enum(['0', '1', 'false', 'true']).optional()
    ).transform((value) => (value === undefined ? undefined : value === '1' || value === 'true'))
  )
}

export function booleanEnv(defaultValue: boolean) {
  return z.preprocess(
    (value) => typeof value === 'string' ? value.trim().toLowerCase() : value,
    z.enum(['0', '1', 'false', 'true'])
      .default(defaultValue ? 'true' : 'false')
      .transform((value) => value === '1' || value === 'true')
  )
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
  // workspace, no connect-code step. Absent for cloud and remote-bridge
  // installs, which pair by hand.
  MANAGED_BRIDGE_TOKEN_FILE: z.string().default('/run/provision/managed-bridge-token'),
  BRIDGE_STATE_FILE: z.string().default('/data/bridge-state.json'),
  // On-disk backups of the bridge's identity + library. Unset disables backups
  // entirely; the whole point of the directory is to live OUTSIDE the bridge's
  // own data dir (its own bind mount in Docker) so wiping or recreating the app
  // cannot take the only copy of the user's files with it.
  BRIDGE_BACKUP_DIR: z.string().optional(),
  // Scheduled backup cadence. 0 keeps backups manual-only ("Back up now").
  BRIDGE_BACKUP_INTERVAL_HOURS: z.coerce.number().nonnegative().default(24),
  BRIDGE_BUILD_REVISION: z.string().trim().min(1).max(120).optional(),
  BRIDGE_SOURCE_FINGERPRINT: z.string().trim().min(1).max(120).optional(),
  // Content hash identifying this build for lockstep updates; bridges update
  // whenever it stops matching the server's current build. Baked at build
  // time (Docker metadata file / SEA define); 'unknown' disables updates.
  BRIDGE_RELEASE_FINGERPRINT: z.string().trim().min(1).max(120).optional(),
  BRIDGE_PROTOCOL_VERSION: z.coerce.number().int().nonnegative().default(1),
  BRIDGE_RUNNER_ABI_VERSION: z.string().trim().min(1).max(120).default('node22-ffmpeg7-v1'),
  // How this bridge takes updates: automatic, manual or pinned (see `update-mode.ts`). Unset means
  // this kind of bridge's default, worked out below.
  BRIDGE_UPDATE_MODE: blankAsUnset(z.string().trim().toLowerCase().pipe(bridgeUpdateModeSchema).optional()),
  // Deprecated spellings of BRIDGE_UPDATE_MODE, read for good because self-hosters' .env files,
  // compose files and standalone config files carry them (CONF-10).
  BRIDGE_AUTO_UPDATE: optionalBooleanEnv(),
  BRIDGE_DISABLE_SELF_UPDATE: optionalBooleanEnv(),
  // Baked true only in the slim Docker bridge image (whose launcher entrypoint
  // activates signed single-file app bundles from the releases dir). The
  // combined app image's bridge role and source runs leave it off and keep the
  // report-only image-pull driver. `BRIDGE_BUNDLE_SELF_UPDATE` is its old name.
  BRIDGE_BUNDLE_SELF_UPDATE_ENABLED: optionalBooleanEnv(),
  BRIDGE_BUNDLE_SELF_UPDATE: optionalBooleanEnv(),
  BRIDGE_RELEASES_DIR: z.string().default('/data/releases'),
  BRIDGE_UPDATE_PUBLIC_KEY: z.string().trim().optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development')
})

const {
  BRIDGE_UPDATE_MODE: configuredUpdateMode,
  BRIDGE_AUTO_UPDATE: legacyAutoUpdate,
  BRIDGE_DISABLE_SELF_UPDATE: legacyDisableSelfUpdate,
  BRIDGE_BUNDLE_SELF_UPDATE_ENABLED: bundleSelfUpdateEnabled,
  BRIDGE_BUNDLE_SELF_UPDATE: legacyBundleSelfUpdate,
  ...parsedEnv
} = envSchema.parse(process.env)

// The slim Docker image installs app bundles, and converges automatically unless told otherwise,
// matching the standalone builds (whose bootstrap sets the mode). Everything else waits for a click.
const BRIDGE_BUNDLE_SELF_UPDATE_ENABLED = bundleSelfUpdateEnabled ?? legacyBundleSelfUpdate ?? false
const updateMode = resolveBridgeUpdateMode(
  { mode: configuredUpdateMode, legacyAutoUpdate, legacyDisableSelfUpdate },
  BRIDGE_BUNDLE_SELF_UPDATE_ENABLED ? 'automatic' : 'manual'
)

/**
 * Configuration notices to log once the bridge's logging is up: deprecated names in use, and
 * settings that contradict each other. Empty for a configuration that uses only current names.
 */
export const bridgeEnvNotices: readonly string[] = [
  ...updateMode.notices,
  ...(bundleSelfUpdateEnabled === undefined && legacyBundleSelfUpdate !== undefined
    ? ['BRIDGE_BUNDLE_SELF_UPDATE is deprecated; set BRIDGE_BUNDLE_SELF_UPDATE_ENABLED instead.']
    : [])
]

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
  BRIDGE_BACKUP_DIR: parsedEnv.BRIDGE_BACKUP_DIR ? resolveWorkspacePath(parsedEnv.BRIDGE_BACKUP_DIR) : undefined,
  BRIDGE_RELEASES_DIR: resolveWorkspacePath(parsedEnv.BRIDGE_RELEASES_DIR),
  BRIDGE_UPDATE_PUBLIC_KEY: normalizePemEnvValue(parsedEnv.BRIDGE_UPDATE_PUBLIC_KEY) ?? OFFICIAL_BRIDGE_UPDATE_PUBLIC_KEY,
  BRIDGE_UPDATE_MODE: updateMode.mode,
  BRIDGE_BUNDLE_SELF_UPDATE_ENABLED
}
