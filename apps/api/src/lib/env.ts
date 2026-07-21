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

function optionalPositiveIntEnv() {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed.length === 0 ? undefined : trimmed
  }, z.coerce.number().int().positive().optional())
}

function booleanEnv(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed.length === 0 ? undefined : trimmed
  }, z.enum(['0', '1', 'false', 'true']).default(defaultValue ? 'true' : 'false').transform((value) => value === '1' || value === 'true'))
}

/**
 * Tri-state boolean: `undefined` when unset (so callers can fall back to a
 * derived default), otherwise the parsed boolean.
 */
function optionalBooleanEnv() {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed.length === 0 ? undefined : trimmed
  }, z.enum(['0', '1', 'false', 'true']).optional().transform((value) => (value === undefined ? undefined : value === '1' || value === 'true')))
}

const envSchema = z.object({
  API_PORT: positiveIntEnv(4000),
  // The connection string the app uses. In the native self-hosted build the
  // `EMBEDDED_POSTGRES` switch starts a local cluster and rewrites this before
  // the env module is imported (see `embedded-postgres.ts` for the ordering and
  // for `EMBEDDED_POSTGRES` / `EMBEDDED_POSTGRES_DATA_DIR` / `EMBEDDED_POSTGRES_PORT`,
  // which are read pre-env and so are intentionally not parsed here).
  DATABASE_URL: z.string().min(1).default('postgresql://postgres:postgres@db:5432/printstream?schema=public'),
  // Prisma connection-pool tuning. Unset → Prisma's default (num_cpus*2+1),
  // which is sized to CPU count, not concurrency. Set CONNECTION_LIMIT to match
  // expected load against the Postgres max_connections budget; POOL_TIMEOUT is
  // the seconds a query waits for a free connection before erroring. Appended to
  // DATABASE_URL as query params (see prisma.ts).
  DATABASE_CONNECTION_LIMIT: optionalPositiveIntEnv(),
  DATABASE_POOL_TIMEOUT: optionalPositiveIntEnv(),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),
  AUTH_LOCAL_EMAIL_CODE_TTL_MINUTES: positiveIntEnv(15),
  AUTO_CREATE_DEFAULT_WORKSPACE: booleanEnv(true),
  DEFAULT_WORKSPACE_SLUG: z.string().default('default'),
  DEFAULT_WORKSPACE_NAME: z.string().default('My Workspace'),
  // Master key for encrypting stored secrets at rest (e.g. OAuth client secrets)
  // via `secret-encryption.ts`. Any non-empty string works (it is hashed to a
  // 32-byte AES key). When unset, secrets are stored as-is — set it in production.
  SECRETS_KEY: optionalStringEnv(),
  // How long durable audit-log rows are retained before scheduled maintenance
  // prunes them. Default 1 year; raise for stricter compliance retention.
  AUDIT_LOG_RETENTION_DAYS: positiveIntEnv(365),
  // Enforce the Content-Security-Policy (`Content-Security-Policy`) vs report-only
  // (`Content-Security-Policy-Report-Only`, the safe default). Flip to true once a
  // deployment has confirmed report-only shows no violations.
  CSP_ENFORCE: booleanEnv(false),
  // Origin of a first-party analytics tracker (e.g. a self-hosted Umami at
  // `https://analytics.example.com`). Added to the CSP's `script-src` +
  // `connect-src` so the tracker script and its event beacons survive
  // enforcement. Leave unset when no cross-origin analytics is used.
  CSP_ANALYTICS_ORIGIN: optionalStringEnv(),
  CLOUDFLARE_EMAIL_ACCOUNT_ID: optionalStringEnv(),
  CLOUDFLARE_EMAIL_API_TOKEN: optionalStringEnv(),
  CLOUDFLARE_EMAIL_FROM_EMAIL: z.preprocess((value) => {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed.length === 0 ? undefined : trimmed
  }, z.string().email().optional()),
  CLOUDFLARE_EMAIL_FROM_NAME: optionalStringEnv(),
  NTFY_TOPIC_URL: optionalStringEnv(),
  // Paddle billing (cloud-only; unset in self-hosted/OSS builds). The private
  // billing module reads these; when absent, billing is inert and plans are unlimited.
  /**
   * Master launch switch for billing enforcement (cloud-only). While false —
   * the beta default — plans exist but nothing is enforced or sold: no Free
   * printer cap, no Pro plugin gating, and checkout/portal actions are
   * refused. Paddle config (below) can be present for admin surfaces and
   * webhook processing without turning enforcement on. Flip to true at launch
   * (staging keeps it true for sandbox testing).
   */
  BILLING_ENFORCEMENT: booleanEnv(false),
  /**
   * Set by the native (paid) self-hosted distribution at boot. Selects the
   * stricter half of license enforcement: a *commercial* key is required after
   * the evaluation window, where the Docker/OSS build also accepts a free
   * community key. Enforcement itself applies to every self-hosted build (see
   * `license-enforcement.ts`), so this is not the switch that arms it. Never
   * set in Docker, OSS, or cloud deployments.
   */
  PRINTSTREAM_NATIVE: booleanEnv(false),
  PADDLE_API_KEY: optionalStringEnv(),
  PADDLE_WEBHOOK_SECRET: optionalStringEnv(),
  /**
   * Paddle client-side token (safe to expose in the browser). Delivered to the
   * checkout page at runtime via `/api/billing/checkout-config` so Paddle.js can
   * open the overlay; separate from the secret server-side API key.
   */
  PADDLE_CLIENT_TOKEN: optionalStringEnv(),
  PADDLE_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  /** Paddle price id for the Pro plan base fee (includes the first 2 printers). */
  PADDLE_PRICE_PRO_BASE: optionalStringEnv(),
  /** Paddle price id for each additional printer beyond the base allotment. */
  PADDLE_PRICE_PRO_PER_PRINTER: optionalStringEnv(),
  /**
   * Paddle price id for the Lifetime self-hosted license: a one-time,
   * perpetual, commercial-use key. Self-hosted only — it confers no cloud plan.
   */
  PADDLE_PRICE_LIFETIME: optionalStringEnv(),
  /**
   * Paddle price id for the annual updates & priority support addon. Applies to
   * Lifetime keys only; a Pro subscription already includes both for as long as
   * it runs, so the addon is never sold against one.
   */
  PADDLE_PRICE_UPDATES_RENEWAL: optionalStringEnv(),
  /**
   * Where a self-hosted install refreshes a subscription-backed license key
   * (see `license-refresh-client.ts`). Ships pointed at the vendor cloud; an
   * override exists only so staging can be exercised against sandbox billing.
   * Perpetual keys never contact it, so this is unused on community/Lifetime
   * installs.
   */
  LICENSE_REFRESH_ORIGIN: z.string().url().default('https://printstream.app'),
  LIBRARY_DIR: z.string().default('./data/library'),
  LIBRARY_MAX_UPLOAD_BYTES: positiveIntEnv(1024 * 1024 * 1024),
  LIBRARY_TRANSIENT_RETENTION_DAYS: positiveIntEnv(7),
  LIBRARY_RECYCLE_RETENTION_DAYS: positiveIntEnv(30),
  LIBRARY_UNREFERENCED_SLICE_RETENTION_HOURS: positiveIntEnv(24),
  /**
   * Base URL(s) of the standalone slicer runtime. Accepts a comma-separated
   * list to fan slices out across multiple identical sidecars (each instance
   * should run one slice at a time — see `SLICING_MAX_CONCURRENT_JOBS`).
   * The parsed list is exported as `SLICER_SERVICE_URLS`.
   */
  SLICER_SERVICE_URL: optionalStringEnv(),
  SLICER_SERVICE_TOKEN: optionalStringEnv(),
  /**
   * Total slicing jobs the API runs at once across all slicer instances.
   * Defaults to the number of configured `SLICER_SERVICE_URL` entries so
   * adding a sidecar adds a slot; override only to run more than one
   * concurrent slice per instance (not recommended — concurrent CLI runs in
   * one container contend on the shared BambuStudio home dir).
   */
  SLICING_MAX_CONCURRENT_JOBS: optionalPositiveIntEnv(),
  SLICING_MAX_QUEUED_JOBS: positiveIntEnv(25),
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
   * Forces the deployment to identify as self-hosted (OSS) or cloud, overriding
   * the build-derived default. Drives which built-in auth provider is active:
   * self-hosted uses `auth-password` (email/password, no email infra needed),
   * cloud uses `auth-local` (passkeys + email codes). Leave unset in production:
   * the default is derived from the presence of the private cloud modules (see
   * `isSelfHostedDeployment`). Set `SELF_HOSTED=true` when running from source to
   * exercise the OSS auth path locally.
   */
  SELF_HOSTED: optionalBooleanEnv(),
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
  // Observability: when enabled, an OpenTelemetry meter provider exposes a
  // Prometheus `/metrics` endpoint on `METRICS_PORT` for an internal scraper.
  // Off by default so the OSS/self-hosted build runs no telemetry stack unless
  // an operator opts in. The port is internal — do not proxy it publicly.
  METRICS_ENABLED: booleanEnv(false),
  METRICS_PORT: positiveIntEnv(9464),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development')
})

const parsedEnv = envSchema.parse(process.env)

/** `SLICER_SERVICE_URL` split into normalized (trailing-slash-free) base URLs. */
const slicerServiceUrls = (parsedEnv.SLICER_SERVICE_URL ?? '')
  .split(',')
  .map((url) => url.trim().replace(/\/+$/, ''))
  .filter((url) => url.length > 0)

export const env = {
  ...parsedEnv,
  SLICER_SERVICE_URLS: slicerServiceUrls,
  // One concurrent slice per slicer instance unless explicitly overridden.
  SLICING_MAX_CONCURRENT_JOBS: parsedEnv.SLICING_MAX_CONCURRENT_JOBS ?? Math.max(1, slicerServiceUrls.length),
  PRINTSTREAM_BRIDGE_SOURCE_FINGERPRINT: parsedEnv.PRINTSTREAM_BRIDGE_SOURCE_FINGERPRINT ?? bridgeBuildMetadata.sourceFingerprint
}
