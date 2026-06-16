/**
 * Centralized environment access. Importing modules should never reach for
 * `process.env` directly so defaults and validation live in one place.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'
import { readFileSync } from 'node:fs'

const envModuleDir = path.dirname(fileURLToPath(import.meta.url))
const workspaceRoot = path.resolve(envModuleDir, '../../../../')

loadDotenv({ path: path.join(workspaceRoot, '.env') })
loadDotenv()

interface BridgeBuildMetadataFile {
  bridgeSourceFingerprint?: unknown
}

function readBridgeBuildMetadata() {
  try {
    const parsed = JSON.parse(readFileSync(path.join(workspaceRoot, 'bridge-build-metadata.json'), 'utf8')) as BridgeBuildMetadataFile
    return {
      sourceFingerprint: typeof parsed.bridgeSourceFingerprint === 'string' && parsed.bridgeSourceFingerprint !== 'unknown'
        ? parsed.bridgeSourceFingerprint
        : undefined
    }
  } catch {
    return {}
  }
}

const bridgeBuildMetadata = readBridgeBuildMetadata()

function optionalStringEnv() {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed.length === 0 ? undefined : trimmed
  }, z.string().optional())
}

function positiveIntEnv(defaultValue: number) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed.length === 0 ? undefined : trimmed
  }, z.coerce.number().int().positive().default(defaultValue))
}

function booleanEnv(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed.length === 0 ? undefined : trimmed
  }, z.enum(['0', '1', 'false', 'true']).default(defaultValue ? 'true' : 'false').transform((value) => value === '1' || value === 'true'))
}

const envSchema = z.object({
  API_PORT: positiveIntEnv(4000),
  DATABASE_URL: z.string().min(1).default('postgresql://postgres:postgres@db:5432/printstream?schema=public'),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),
  AUTH_LOCAL_EMAIL_CODE_TTL_MINUTES: positiveIntEnv(15),
  AUTO_CREATE_DEFAULT_WORKSPACE: booleanEnv(true),
  DEFAULT_WORKSPACE_SLUG: z.string().default('default'),
  DEFAULT_WORKSPACE_NAME: z.string().default('My Workspace'),
  CLOUDFLARE_EMAIL_ACCOUNT_ID: optionalStringEnv(),
  CLOUDFLARE_EMAIL_API_TOKEN: optionalStringEnv(),
  CLOUDFLARE_EMAIL_FROM_EMAIL: z.preprocess((value) => {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed.length === 0 ? undefined : trimmed
  }, z.string().email().optional()),
  CLOUDFLARE_EMAIL_FROM_NAME: optionalStringEnv(),
  NTFY_TOPIC_URL: optionalStringEnv(),
  LIBRARY_DIR: z.string().default('./data/library'),
  LIBRARY_MAX_UPLOAD_BYTES: positiveIntEnv(1024 * 1024 * 1024),
  LIBRARY_TRANSIENT_RETENTION_DAYS: positiveIntEnv(7),
  LIBRARY_RECYCLE_RETENTION_DAYS: positiveIntEnv(30),
  LIBRARY_UNREFERENCED_SLICE_RETENTION_HOURS: positiveIntEnv(24),
  SLICER_SERVICE_URL: optionalStringEnv(),
  SLICER_SERVICE_TOKEN: optionalStringEnv(),
  SLICING_MAX_CONCURRENT_JOBS: positiveIntEnv(1),
  SLICING_MAX_QUEUED_JOBS: positiveIntEnv(10),
  SLICING_REQUEST_TIMEOUT_MS: positiveIntEnv(30 * 60 * 1000),
  SLICING_MAX_ARTIFACT_BYTES: positiveIntEnv(1024 * 1024 * 1024),
  BRIDGE_RELEASES_DIR: z.string().default('./data/bridge-releases'),
  PRINTSTREAM_BRIDGE_SOURCE_FINGERPRINT: optionalStringEnv(),
  /**
   * Managed-bridge mode. When true, this server provisions and owns a single
   * bundled bridge: it auto-pairs the bridge that presents the matching
   * provisioning token (see `MANAGED_BRIDGE_TOKEN_FILE`) into the sole
   * workspace, and the web app hides every bridge-management surface (see
   * `runtimePolicy.managedBridge`). Leave false in cloud and remote-bridge
   * installs, which keep the connect-code pairing flow.
   */
  MANAGED_BRIDGE: booleanEnv(false),
  /**
   * Path to the managed-bridge provisioning token. In managed mode the API
   * generates this token on first start (if absent) and the bundled bridge
   * reads it from the same path over a shared mount to authenticate its
   * auto-pairing registration. No operator ever sets the token value; only the
   * file location is configurable, and it must resolve to the same file in
   * both containers.
   */
  MANAGED_BRIDGE_TOKEN_FILE: z.string().default('/run/provision/managed-bridge-token'),
  PRINT_JOB_THUMBNAIL_RETENTION_DAYS: positiveIntEnv(90),
  PLUGINS_DIR: z.string().default('./data/plugins'),
  /**
   * Directory of the built web SPA (`apps/web/dist`) for the API to serve on
   * its own port, alongside `/api` and `/ws` — the single-container topology
   * (no separate nginx `web` service). The combined Docker image points this at
   * the embedded `dist`. Leave unset for the split topology, where nginx or a
   * CDN serves the SPA and the API only handles `/api` + `/ws`. See
   * `serve-web.ts`.
   */
  SERVE_WEB_DIR: optionalStringEnv(),
  /**
   * Express `trust proxy` setting. Use when running behind nginx /
   * Caddy / any reverse proxy so `req.ip`, `req.protocol`, and
   * `req.secure` reflect the original client instead of the proxy.
   *
   * Accepted values mirror Express:
   * - `true` — trust all proxies (use only when the proxy network is
   *   tightly controlled).
   * - integer — number of hops to trust (e.g. `1` for a single nginx).
   * - IP / CIDR list (comma-separated) — trust specific upstreams.
   * Leave unset in single-process / direct-to-internet deployments.
   */
  TRUST_PROXY: optionalStringEnv(),
  /**
   * Public base URL of this API instance (no trailing slash). Used to
   * build absolute URLs for media included with notifications, since
   * external delivery channels (Discord, ntfy) cannot reach a relative
   * path, and as the origin for bridge release-asset URLs (where it
   * beats the request-derived origin, which proxy chains that hide the
   * original protocol can get wrong). Leave unset for LAN-only installs;
   * in that case Discord/ntfy notifications will skip the snapshot embed.
   */
  PUBLIC_BASE_URL: z.preprocess((value) => {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed.length === 0 ? undefined : trimmed
  }, z.string().url().optional()),
  /**
   * Optional tenant-routing suffix for cloud-hosted deployments.
   * Example: when set to `printstream.example.com`, requests for
   * `acme.printstream.example.com` resolve to the `acme` tenant.
   */
  TENANT_DOMAIN_SUFFIX: z.preprocess((value) => {
    if (typeof value !== 'string') return value
    const trimmed = value.trim().toLowerCase()
    return trimmed.length === 0 ? undefined : trimmed
  }, z.string().min(1).optional()),
  /**
   * When true, log raw MQTT publish/receive payload summaries to the
   * API console for printer protocol debugging. Off by default so dev
   * logs stay readable unless explicitly requested.
   */
  MQTT_DEBUG_LOGS: booleanEnv(false),
  PUBLIC_DEMO_BRIDGE_LIBRARY_DIR: z.string().default('./data/demo-library'),
  /**
   * Disable the outbound GHCR check that powers the footer "update available"
   * hint. Only the published open-core image checks at all; set this to opt that
   * image out of the periodic registry request. See `app-update-check.ts`.
   */
  PRINTSTREAM_DISABLE_UPDATE_CHECK: booleanEnv(false),
  /**
   * Registry repository the update check compares against, as `owner/name`
   * (no registry host or tag). Defaults to the canonical open-core image;
   * override for a fork that publishes its own GHCR image.
   */
  PRINTSTREAM_UPDATE_CHECK_IMAGE: z.string().default('printstreamapp/printstream'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development')
})

const parsedEnv = envSchema.parse(process.env)

export const env = {
  ...parsedEnv,
  PRINTSTREAM_BRIDGE_SOURCE_FINGERPRINT: parsedEnv.PRINTSTREAM_BRIDGE_SOURCE_FINGERPRINT ?? bridgeBuildMetadata.sourceFingerprint
}
