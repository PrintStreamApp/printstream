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
  bridgeReleaseFingerprint?: unknown
}

function readBridgeBuildMetadata() {
  try {
    const parsed = JSON.parse(readFileSync(path.join(workspaceRoot, 'bridge-build-metadata.json'), 'utf8')) as BridgeBuildMetadataFile
    const clean = (value: unknown): string | undefined =>
      typeof value === 'string' && value !== 'unknown' && value.length > 0 ? value : undefined
    return {
      sourceFingerprint: clean(parsed.bridgeSourceFingerprint),
      // The bridge build THIS image's commit expects, computed by the Dockerfile
      // from `bridge-release-fingerprint.sh`. Lets the server notice it is
      // serving a bridge that is not its own; see `bridge-update-policy.ts`.
      releaseFingerprint: clean(parsed.bridgeReleaseFingerprint)
    }
  } catch {
    return {}
  }
}

const bridgeBuildMetadata = readBridgeBuildMetadata()

/**
 * "Unset" and "set to nothing" mean the same thing for every variable here.
 *
 * Load-bearing rather than tidy: this repo maps env into containers as
 * `VAR: ${VAR:-}`, which passes an EMPTY STRING when the `.env` line is absent,
 * so a schema that only admits `undefined` rejects the most common operator
 * mistake, and a `z.parse` failure at module load kills the process before it
 * can log anything useful. `PLATFORM_ADMIN_EMAIL` shipped that way: an empty
 * value crash-looped the API instead of reaching its own "set this to claim the
 * platform admin" refusal.
 *
 * Every optional variable goes through here so the rule is a property of the
 * file rather than something each one opts into by hand.
 */
function trimmedEnv<Schema extends z.ZodTypeAny>(schema: Schema) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed.length === 0 ? undefined : trimmed
  }, schema)
}

function optionalStringEnv() {
  return trimmedEnv(z.string().optional())
}

function positiveIntEnv(defaultValue: number) {
  return trimmedEnv(z.coerce.number().int().positive().default(defaultValue))
}

function optionalPositiveIntEnv() {
  return trimmedEnv(z.coerce.number().int().positive().optional())
}

function booleanEnv(defaultValue: boolean) {
  return trimmedEnv(z.enum(['0', '1', 'false', 'true']).default(defaultValue ? 'true' : 'false').transform((value) => value === '1' || value === 'true'))
}

/**
 * Tri-state boolean: `undefined` when unset (so callers can fall back to a
 * derived default), otherwise the parsed boolean.
 */
function optionalBooleanEnv() {
  return trimmedEnv(z.enum(['0', '1', 'false', 'true']).optional().transform((value) => (value === undefined ? undefined : value === '1' || value === 'true')))
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
  /**
   * The deployment's canonical browser origin(s), comma-separated. Read it
   * through `lib/client-origins.ts` (never split inline); the FIRST entry is
   * the canonical origin.
   *
   * NOT a CORS-only knob, despite the name: CORS (`app.ts`) is one reader
   * among several. It is also the WebAuthn relying-party id and expected
   * origin (`auth-local/passkeys.ts`), the OIDC redirect base (`auth-oauth`),
   * the fallback for deciding the `Secure` cookie flag (`auth-session.ts`),
   * and, on the cloud, the origin every Paddle checkout is pinned to. An
   * operator who reads this as "only needed for a split topology" and drops it
   * on the cloud breaks every passkey sign-in, because the relying-party id
   * silently becomes `localhost`.
   *
   * Empty collapses to the dev default, like unset.
   */
  CLIENT_ORIGIN: trimmedEnv(z.string().default('http://localhost:5173')),
  AUTH_LOCAL_EMAIL_CODE_TTL_MINUTES: positiveIntEnv(15),
  /**
   * Create a default workspace on first start when the database has none.
   * Tri-state on purpose: unset derives from the deployment: self-hosted
   * installs get one (the app should just work out of the box), the
   * multi-workspace cloud does not (its workspaces come from signups, and an
   * empty database is the FIRST-RUN state, not a broken one). See
   * `default-workspace.ts` for the resolution.
   */
  AUTO_CREATE_DEFAULT_WORKSPACE: optionalBooleanEnv(),
  DEFAULT_WORKSPACE_SLUG: z.string().default('default'),
  DEFAULT_WORKSPACE_NAME: z.string().default('My Workspace'),
  // Master key for encrypting stored secrets at rest (e.g. OAuth client secrets)
  // via `secret-encryption.ts`. Any non-empty string works (it is hashed to a
  // 32-byte AES key). When unset, secrets are stored as-is: set it in production.
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
  CLOUDFLARE_EMAIL_FROM_EMAIL: trimmedEnv(z.string().email().optional()),
  CLOUDFLARE_EMAIL_FROM_NAME: optionalStringEnv(),
  NTFY_TOPIC_URL: optionalStringEnv(),
  // Paddle billing (cloud-only; unset in self-hosted/OSS builds). The private
  // billing module reads these; when absent, billing is inert and plans are unlimited.
  /**
   * Master switch for billing enforcement (cloud-only). While false, plans
   * exist but nothing is enforced or sold: no Free
   * printer cap, no Pro plugin gating, and checkout/portal actions are
   * refused. Paddle config (below) can be present for admin surfaces and
   * webhook processing without turning enforcement on. Production and staging
   * keep it true; false is the safe posture for a new or incomplete deployment.
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
  /**
   * Which native-build channel this deployment offers for download.
   *
   * `stable` is the shipping app. `staging` is the test channel, whose binaries
   * verify licences against staging's throwaway signing key, so they accept
   * keys this staging deployment issues and REJECT every real one. Setting this
   * to `staging` on production would hand paying customers a build that refuses
   * their licence, which is why it is an explicit named value rather than
   * anything inferred.
   */
  SELF_HOST_RELEASE_CHANNEL: trimmedEnv(z.enum(['stable', 'staging']).default('stable')),
  PADDLE_API_KEY: optionalStringEnv(),
  /**
   * The name charges appear as on a customer's bank statement, exactly as it is
   * set in Paddle's checkout settings (e.g. `PRINTSTRM`).
   *
   * Configured rather than read from Paddle because Paddle's API does not expose
   * it, it is a dashboard setting with no endpoint behind it. Configured rather
   * than hardcoded because a wrong value here is worse than none: an unfamiliar
   * name on a statement is what a chargeback starts as, and telling someone the
   * wrong one sends them looking for a charge that is not there under that name.
   * Unset simply omits the sentence.
   */
  PADDLE_STATEMENT_DESCRIPTOR: optionalStringEnv(),
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
   * Paddle price ids for SELF-HOSTED Pro, the same $/printer shape as cloud Pro
   * but a distinct product: a customer buys one or the other, never both, so
   * sharing the cloud price ids would make the two indistinguishable in Paddle
   * and in our own webhooks.
   *
   * Metered exactly like cloud, with one difference in where the number comes
   * from: the install ASKS the cloud to change its printer count and the answer
   * is signed into the key, because a count reported by software running on the
   * customer's machine is not a billable fact (the Docker build is open source).
   */
  PADDLE_PRICE_SELF_HOSTED_PRO_BASE: optionalStringEnv(),
  PADDLE_PRICE_SELF_HOSTED_PRO_PER_PRINTER: optionalStringEnv(),
  /**
   * Paddle price id for the Lifetime self-hosted license: a one-time,
   * perpetual, commercial-use key. Self-hosted only, it confers no cloud plan.
   */
  PADDLE_PRICE_LIFETIME: optionalStringEnv(),
  /**
   * Paddle price id for the annual updates & priority support addon. Applies to
   * Lifetime keys only; a Pro subscription already includes both for as long as
   * it runs, so the addon is never sold against one.
   */
  PADDLE_PRICE_UPDATES_RENEWAL: optionalStringEnv(),
  /**
   * Read-only GitHub token used to resolve signed download URLs for the native
   * self-hosted builds, which are assets on a PRIVATE release. Needs no more
   * than `contents: read` on that one repository. Unset elsewhere: the download
   * route reports "not available on this deployment" rather than failing.
   */
  GITHUB_RELEASE_TOKEN: optionalStringEnv(),
  /** `owner/repo` holding the native build releases. */
  GITHUB_RELEASE_REPO: optionalStringEnv(),
  /**
   * Paddle discount id for the beta-exit launch promo on Pro. Must be a
   * *recurring* percentage discount restricted to the Pro price ids: it rides
   * every later item change, so an eligible subscriber keeps the promo rate
   * when they add printers, long after the promo window closes. See
   * `private/cloud/launch-promo.ts` for why this is a discount and not a
   * second set of half-price price ids.
   */
  PADDLE_DISCOUNT_LAUNCH_PROMO_PRO: optionalStringEnv(),
  /**
   * Paddle discount id for the launch promo on the Lifetime license: one-time,
   * restricted to the Lifetime price id. Kept separate from the Pro discount so
   * it can be withdrawn when the window closes without touching the recurring
   * discount on live Pro subscriptions.
   */
  PADDLE_DISCOUNT_LAUNCH_PROMO_LIFETIME: optionalStringEnv(),
  /**
   * OVERRIDE for where a self-hosted install refreshes a subscription-backed
   * license key. Normally leave this unset: the key itself names the deployment
   * that issued it (`refreshOrigin`), which cannot drift from the truth because
   * it is signed. Setting this wins anyway, an operator behind a rewriting
   * proxy needs an escape hatch, and a disagreement with the key is logged.
   *
   * Resolution lives in `license-origin.ts`, never read directly: the fallback
   * chain is the contract, not this variable. Perpetual keys never refresh, so
   * community/Lifetime installs ignore all of it.
   */
  LICENSE_REFRESH_ORIGIN: z.string().url().optional(),
  LIBRARY_DIR: z.string().default('./data/library'),
  /**
   * Where the built-in server backups live (issue #78). Deliberately its own
   * mount in the Compose stack (`/backups`) and a sibling of the data tree on
   * the native build, so wiping or recreating the app cannot take the backups
   * with it. UNSET disables backups entirely, a default inside the container
   * filesystem would let an install with an un-updated compose file write
   * "backups" that die with the container. Cloud manages the surface from the
   * platform workspace (workspace admins never see it).
   */
  BACKUPS_DIR: optionalStringEnv(),
  /** Scheduled server-backup cadence. 0 keeps backups manual-only. */
  BACKUP_INTERVAL_HOURS: z.coerce.number().nonnegative().default(24),
  /**
   * Overrides for the Postgres client tools the backup system shells out to.
   * Resolution order without them: `EMBEDDED_POSTGRES_BIN_DIR` (native), then
   * PATH. The Docker image ships matching `postgresql-client` tools.
   */
  PG_DUMP_PATH: optionalStringEnv(),
  PG_RESTORE_PATH: optionalStringEnv(),
  LIBRARY_MAX_UPLOAD_BYTES: positiveIntEnv(1024 * 1024 * 1024),
  LIBRARY_TRANSIENT_RETENTION_DAYS: positiveIntEnv(7),
  LIBRARY_RECYCLE_RETENTION_DAYS: positiveIntEnv(30),
  /**
   * How long a deleted workspace stays restorable before the sweep removes it
   * for good. Matches the library recycle bin by default rather than inventing
   * a second number for the same idea: both are "you can still change your
   * mind", and a user who has learned one should not have to learn the other.
   */
  WORKSPACE_DELETED_RETENTION_DAYS: positiveIntEnv(30),
  LIBRARY_UNREFERENCED_SLICE_RETENTION_HOURS: positiveIntEnv(24),
  /**
   * Base URL(s) of the standalone slicer runtime. Accepts a comma-separated
   * list to fan slices out across multiple identical sidecars (each instance
   * should run one slice at a time: see `SLICING_MAX_CONCURRENT_JOBS`).
   * The parsed list is exported as `SLICER_SERVICE_URLS`.
   */
  SLICER_SERVICE_URL: optionalStringEnv(),
  SLICER_SERVICE_TOKEN: optionalStringEnv(),
  /**
   * Total slicing jobs the API runs at once across all slicer instances.
   * Defaults to the number of configured `SLICER_SERVICE_URL` entries so
   * adding a sidecar adds a slot; override only to run more than one
   * concurrent slice per instance (not recommended: concurrent CLI runs in
   * one container contend on the shared BambuStudio home dir).
   */
  SLICING_MAX_CONCURRENT_JOBS: optionalPositiveIntEnv(),
  SLICING_MAX_QUEUED_JOBS: positiveIntEnv(25),
  SLICING_REQUEST_TIMEOUT_MS: positiveIntEnv(30 * 60 * 1000),
  SLICING_MAX_ARTIFACT_BYTES: positiveIntEnv(1024 * 1024 * 1024),
  /**
   * Anonymous slicing is opt-in on self-hosted deployments and on by default in the cloud. The
   * The cloud-only policy lives under `private/cloud/public-slicing/policy.ts`.
   */
  PUBLIC_SLICING_ENABLED: optionalBooleanEnv(),
  PUBLIC_SLICING_MAX_CONCURRENT_JOBS: optionalPositiveIntEnv(),
  PUBLIC_SLICING_MAX_QUEUED_JOBS: positiveIntEnv(20),
  PUBLIC_SLICING_MAX_QUEUED_JOBS_PER_IP: positiveIntEnv(2),
  PUBLIC_SLICING_MAX_ACTIVE_JOBS_PER_IP: positiveIntEnv(1),
  PUBLIC_SLICING_MAX_INPUT_BYTES: positiveIntEnv(256 * 1024 * 1024),
  PUBLIC_SLICING_MAX_INFLATED_BYTES: positiveIntEnv(512 * 1024 * 1024),
  PUBLIC_SLICING_MAX_OUTPUT_BYTES: positiveIntEnv(512 * 1024 * 1024),
  PUBLIC_SLICING_JOB_TTL_MINUTES: positiveIntEnv(60),
  PUBLIC_SLICING_UPLOAD_TTL_MINUTES: positiveIntEnv(30),
  PUBLIC_SLICING_MAX_RUNTIME_MS: positiveIntEnv(20 * 60 * 1000),
  BRIDGE_RELEASES_DIR: z.string().default('./data/bridge-releases'),
  // Native (SEA) server builds the live cloud server offers for download. Not
  // documented in the example env files on purpose: it is internal plumbing for
  // the release channel, and a self-hosted server never promotes a build.
  SERVER_RELEASES_DIR: z.string().default('./data/server-releases'),
  // Undocumented on purpose (absent from every .env.example and doc): the
  // native update check polls a BAKED origin, and this exists only to point a
  // test at a fixture. See native-update-check.ts.
  NATIVE_UPDATE_ORIGIN: optionalStringEnv(),
  // Published by the native app at boot (apps/server/src/run.ts) from the
  // fingerprint baked into its binary. Absent everywhere else, which is what
  // keeps the native update check inert on Docker/dev runs.
  PRINTSTREAM_SERVER_FINGERPRINT: optionalStringEnv(),
  // The native app's one-click in-place update (native-update-apply.ts). All
  // published by apps/server/src at boot, absent everywhere else, their
  // absence is what keeps the apply path refusing on Docker/dev runs:
  // - PRINTSTREAM_SERVER_EXE: the installed executable to swap. Only ever set
  //   by a PACKAGED native run, so a dev process can never swap its own node.
  // - PRINTSTREAM_SERVER_VERSION: the product SemVer baked into the native binary.
  // - PRINTSTREAM_SERVER_BUILD_REVISION: the git revision baked into the native
  //   binary; the footer's build identity (app-build-info.ts falls back to it,
  //   since only Docker images carry app-build-metadata.json).
  // - PRINTSTREAM_UPDATE_STATE_FILE / PRINTSTREAM_UPDATE_HELD_BACK_FILE: the
  //   pending-update + hold-back bookkeeping shared with the boot-side backup
  //   and crash-loop rollback in apps/server/src/run.ts.
  // - NATIVE_UPDATE_PUBLIC_KEY: test-only trust-root override, undocumented
  //   like NATIVE_UPDATE_ORIGIN; shipped builds use the baked official key.
  PRINTSTREAM_SERVER_EXE: optionalStringEnv(),
  PRINTSTREAM_SERVER_VERSION: optionalStringEnv(),
  PRINTSTREAM_SERVER_BUILD_REVISION: optionalStringEnv(),
  PRINTSTREAM_UPDATE_STATE_FILE: optionalStringEnv(),
  PRINTSTREAM_UPDATE_HELD_BACK_FILE: optionalStringEnv(),
  NATIVE_UPDATE_PUBLIC_KEY: optionalStringEnv(),
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
   * Who may claim a fresh CLOUD deployment's first platform-admin account.
   *
   * The first-run claim is first-comer on self-hosted installs, which is fine on
   * a LAN; a cloud host is public the moment DNS resolves, so its claim must be
   * pinned to an operator-chosen address instead of raced for. Cloud-only:
   * ignored entirely on self-hosted builds, and irrelevant once the first
   * platform user exists.
   */
  PLATFORM_ADMIN_EMAIL: trimmedEnv(z.string().email().optional()),
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
   * its own port, alongside `/api` and `/ws`: the single-container topology
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
   * - `true`: trust all proxies (use only when the proxy network is
   *   tightly controlled).
   * - integer: number of hops to trust (e.g. `1` for a single nginx).
   * - IP / CIDR list (comma-separated): trust specific upstreams.
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
  PUBLIC_BASE_URL: trimmedEnv(z.string().url().optional()),
  /**
   * Optional workspace-routing suffix for cloud-hosted deployments.
   * Example: when set to `printstream.example.com`, requests for
   * `acme.printstream.example.com` resolve to the `acme` workspace.
   */
  // Lower-cased because it is matched against a request Host header, which
  // carries whatever casing the client sent.
  WORKSPACE_DOMAIN_SUFFIX: trimmedEnv(z.string().min(1).optional().transform((value) => value?.toLowerCase())),
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
  // an operator opts in. The port is internal: do not proxy it publicly.
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

/**
 * Resolve the anonymous share of the slicer pool.
 *
 * Production always reserves one slot for workspace work. A one-slot development process has no
 * competing users to protect, so it may lend that slot to the public editor; otherwise the normal
 * dev setup can expose the catalogue but can never execute the slice it offers.
 */
export function resolvePublicSlicingMaxConcurrentJobs(input: {
  totalJobs: number
  requestedAnonymousJobs?: number
  nodeEnv: 'development' | 'test' | 'production'
}): number {
  const reservedWorkspaceJobs = input.nodeEnv === 'production' ? 1 : 0
  const availableAnonymousJobs = Math.max(0, input.totalJobs - reservedWorkspaceJobs)
  return Math.min(input.requestedAnonymousJobs ?? 1, availableAnonymousJobs)
}

const slicingMaxConcurrentJobs = parsedEnv.SLICING_MAX_CONCURRENT_JOBS
  ?? Math.max(1, slicerServiceUrls.length)

export const env = {
  ...parsedEnv,
  SLICER_SERVICE_URLS: slicerServiceUrls,
  // One concurrent slice per slicer instance unless explicitly overridden.
  SLICING_MAX_CONCURRENT_JOBS: slicingMaxConcurrentJobs,
  PUBLIC_SLICING_MAX_CONCURRENT_JOBS: resolvePublicSlicingMaxConcurrentJobs({
    totalJobs: slicingMaxConcurrentJobs,
    requestedAnonymousJobs: parsedEnv.PUBLIC_SLICING_MAX_CONCURRENT_JOBS,
    nodeEnv: parsedEnv.NODE_ENV
  }),
  PRINTSTREAM_BRIDGE_SOURCE_FINGERPRINT: parsedEnv.PRINTSTREAM_BRIDGE_SOURCE_FINGERPRINT ?? bridgeBuildMetadata.sourceFingerprint,
  /**
   * The bridge build this server's own commit expects. Not operator-settable:
   * it describes the image, so an override could only ever make the server
   * agree with a bridge that is not its own.
   */
  PRINTSTREAM_BRIDGE_RELEASE_FINGERPRINT: bridgeBuildMetadata.releaseFingerprint
}
