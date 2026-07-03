# Configuration reference

See `.env.dev.example` in the workspace root for local development and `.env.server.example` for the server stack. Those files intentionally list only the vars a typical install sets; every other key has a working default and can simply be added to your workspace-root `.env` to override. This table is the complete, overridable reference:

| Variable | Default | Description |
|---|---|---|
| `API_PORT` | `4000` | API HTTP port. |
| `NODE_ENV` | `development` | Runtime mode (`development` / `production` / `test`). The Compose stacks set `production`. |
| `DATABASE_URL` | `postgresql://postgres:postgres@db:5432/printstream?schema=public` | Prisma PostgreSQL URL. The default expects the repo's Compose/devcontainer `db` service; use `localhost` or another host only if you run Postgres outside Compose. |
| `DATABASE_CONNECTION_LIMIT` | *(Prisma default: CPUs×2+1)* | Prisma connection-pool size for this process. Set it to match expected concurrency against the Postgres `max_connections` budget; the CPU-count default can bottleneck a busy single-process multi-tenant API. Appended to `DATABASE_URL` as `connection_limit`. |
| `DATABASE_POOL_TIMEOUT` | *(Prisma default: 10s)* | Seconds a query waits for a free pooled connection before erroring (P2024). Appended to `DATABASE_URL` as `pool_timeout`. |
| `DB_WAIT_TIMEOUT_MS` | `60000` | Max time `npm run dev:db` waits for Postgres to accept connections before failing. |
| `DB_WAIT_RETRY_MS` | `1000` | Poll interval `npm run dev:db` uses while waiting for Postgres. |
| `CLIENT_ORIGIN` | `http://localhost:5173` | Comma-separated list of allowed browser origins. |
| `BRIDGE_SERVER_URL` | `http://api:4000` | PrintStream server URL the bridge registers with. The default expects the bridge to reach the API over the same Docker network by service name; override to `http://localhost:4000` when the bridge runs outside Docker. (`BRIDGE_CLOUD_URL` is accepted as a legacy alias.) |
| `BRIDGE_LIBRARY_DIR` | `./data/bridge-library` | Bridge-local directory for library-owned files and dispatch replicas. |
| `BRIDGE_NAME` | `PrintStream Bridge` | Human-readable name used when the bridge registers and is connected to a workspace. |
| `MANAGED_BRIDGE` | `false` (public Docker example defaults it on) | Enables **managed-bridge mode** for single-host self-hosting: the bundled bridge auto-pairs into the sole workspace and the Bridges settings page is hidden. Set `false` to keep manual connect-code pairing (cloud, multiple bridges, or a bridge on a separate host). |
| `MANAGED_BRIDGE_TOKEN_FILE` | `/run/provision/managed-bridge-token` | Path to the managed-bridge provisioning token. In managed mode the API generates this token on first start; the bundled bridge reads it from the same path over a shared mount to authenticate its auto-pairing. Operators never set the token value — only the file location, which must resolve to the same file in both containers. |
| `BRIDGE_STATE_FILE` | `./data/bridge-state.json` | Path where the bridge persists its connected identity and runtime token. |
| `BRIDGE_AUTO_UPDATE` | `false` | Standalone bridges only: when true, a standalone executable installs an available compatible update in place after registration. Docker bridges update by image pull and ignore this. |
| `BRIDGE_RELEASES_DIR` | `./data/releases` | Standalone bridges only: directory for staged self-update binaries. Docker bridges keep no release state (the image is the unit of update). |
| `BRIDGE_UPDATE_PUBLIC_KEY` | official PrintStream key | Optional Ed25519 public key override for verifying signed standalone updates. Normal bridge installs should leave this unset. Compose `.env` files may use a one-line PEM with `\n` escapes when overriding. |
| API `BRIDGE_RELEASES_DIR` | `./data/bridge-releases` | API-container directory containing signed bridge release JSON fragments and the standalone binary assets served to bridges. |
| `SECRETS_KEY` | *(unset)* | Master key for encrypting sensitive stored settings at rest (currently OAuth client secrets) via AES-256-GCM. Any non-empty string works (it is hashed to a 32-byte key). When unset, those settings are stored unencrypted and a warning is logged — **set this in production**. Existing plaintext values keep working and are re-encrypted on next write. Treat it as a secret; rotating it makes previously-encrypted values unreadable (re-enter them). |
| `AUDIT_LOG_RETENTION_DAYS` | `365` | How long durable audit-log rows are retained before scheduled maintenance prunes them. Raise for stricter compliance retention. |
| `CSP_ENFORCE` | `false` | When `true`, the Content-Security-Policy is enforced (`Content-Security-Policy`); when `false` it is sent report-only (`Content-Security-Policy-Report-Only`). Roll out report-only first, confirm no violations in the browser console, then set `true`. |
| `CLOUDFLARE_EMAIL_ACCOUNT_ID` | *(unset)* | Cloudflare account ID for Email Sending. Required for local-auth one-time email codes outside demo mode. |
| `CLOUDFLARE_EMAIL_API_TOKEN` | *(unset)* | Cloudflare API token with Email Sending permission. Treat this as a secret and rotate it if exposed. |
| `CLOUDFLARE_EMAIL_FROM_EMAIL` | *(unset)* | Verified sender address for Cloudflare Email Sending. |
| `CLOUDFLARE_EMAIL_FROM_NAME` | *(unset)* | From display name for Cloudflare Email Sending. |
| `AUTH_LOCAL_EMAIL_CODE_TTL_MINUTES` | `15` | Expiry window for local-auth one-time email codes. |
| `SELF_HOSTED` | *(derived from the build)* | Forces the deployment to identify as self-hosted/OSS (`true`) or cloud (`false`), overriding the default (derived from whether the private cloud modules are present). Self-hosted registers the email/password provider (`auth-password`) and hides the cloud platform-admin, marketing, and support-access surfaces; cloud registers passkeys + email codes (`auth-local`) and OIDC SSO (`auth-oauth`). Leave unset in real deployments; set `true` to run the OSS build from the full source tree. |
| `LIBRARY_DIR` | `./data/library` | Directory where uploaded `.3mf`/`.gcode`/`.stl`/`.step` files are stored. |
| `LIBRARY_MAX_UPLOAD_BYTES` | `1073741824` | Maximum accepted library upload size in bytes (default 1 GiB). |
| `LIBRARY_TRANSIENT_RETENTION_DAYS` | `7` | How long hidden transient library uploads are retained before scheduled cleanup removes them. |
| `LIBRARY_RECYCLE_RETENTION_DAYS` | `30` | How long recycle-bin (soft-deleted) library files stay restorable before scheduled cleanup removes them permanently. |
| `LIBRARY_UNREFERENCED_SLICE_RETENTION_HOURS` | `24` | How long unreferenced sliced outputs (never saved to the library or snapshotted for print history) are kept before cleanup removes them. |
| `SLICER_SERVICE_URL` | *(unset)* | Optional URL for the standalone slicer container. Set to enable server-side slicing orchestration. Accepts a comma-separated list of identical slicer instances; slices are assigned to the least-busy instance and progress follows the instance that owns the job. |
| `SLICER_SERVICE_TOKEN` | *(unset)* | Optional bearer token shared between the API and slicer container. Treat this as a secret. |
| `SLICER_BIND_HOST` | `127.0.0.1` | Host interface for the published slicer port in Compose (`127.0.0.1` keeps it private to the server). |
| `SLICER_BIND_PORT` | `4010` | Host port mapped to slicer container port `4010` in Compose. |
| `SLICING_MAX_CONCURRENT_JOBS` | *(one per slicer URL)* | Maximum slicing jobs the API runs at once across all slicer instances. Defaults to the number of configured `SLICER_SERVICE_URL` entries. Raising it above that makes single instances run concurrent CLI slices, which contend on the shared per-target BambuStudio home dir — prefer adding instances instead. |
| `SLICING_MAX_QUEUED_JOBS` | `25` | Maximum number of queued slicing jobs waiting for a concurrency slot. |
| `SLICING_REQUEST_TIMEOUT_MS` | `1800000` | Timeout for API-to-slicer requests. |
| `SLICER_DEFAULT_TARGET_ID` | *(first installed target)* | Override the default slicer version shown in the slice dialog. Must match an `id` from the built-in target manifest (`/opt/printstream-slicers/targets.json`). |
| `SLICER_ENABLE_PIPE_PROGRESS` | `true` | When `true`, append Bambu/Orca CLI `--pipe` progress JSON frames into slicing job output so the UI can render determinate progress updates. |
| `SLICER_BAMBUSTUDIO_HOME_DIR` | under slicer work dir | Isolated home directory used when launching BambuStudio. Subdirectories are created per target id. |
| `SLICER_BAMBUSTUDIO_DATA_DIR` | under slicer work dir | Persistent `--datadir` used for slicer presets and first-run state. Subdirectories are created per target id. |
| `PRINT_JOB_THUMBNAIL_RETENTION_DAYS` | `90` | How long completed-job thumbnail PNGs and persisted final-frame snapshot JPGs are retained before scheduled cleanup removes them. |
| `PLUGINS_DIR` | `./data/plugins` | Directory for installed external plugins. |
| `TRUST_PROXY` | *(unset)* | Express `trust proxy` setting; set when behind a reverse proxy. |
| `SERVE_WEB_DIR` | `/app/apps/web/dist` (combined image) | Directory of the built web SPA the API serves on its own port, alongside `/api` and `/ws` — the single-container topology. The Docker image bakes this in. Set to empty to run the API alone behind a separate web tier (the split topology). |
| `DISCOVERY_PORT` | `2021` | UDP port the bridge uses for SSDP printer auto-discovery. |
| `PUBLIC_BASE_URL` | *(unset)* | Absolute URL used for notification media embeds (e.g. camera snapshots). |
| `MQTT_DEBUG_LOGS` | `false` | Set to `true` or `1` to log raw MQTT publish/receive traffic for protocol debugging. |
| `CAMERA_DEBUG_LOGS` | `false` | Set to `true` or `1` to re-enable verbose RTSP camera readiness logs such as `snapshot ready` and `first frame`. |
| `METRICS_ENABLED` | `false` | When `true`, expose a Prometheus `/metrics` endpoint (OpenTelemetry) on `METRICS_PORT` for an internal scraper. Off by default — the app runs no telemetry stack unless you opt in. See `docs/observability.md`. |
| `METRICS_PORT` | `9464` | Port the Prometheus metrics endpoint binds when `METRICS_ENABLED` is set. **Internal only** — keep it on a private interface/network; do not proxy it publicly. |
| `NTFY_TOPIC_URL` | *(unset)* | Fallback ntfy topic for the notifications-ntfy plugin when a tenant has not configured its own. Honored **only** in single-box managed-bridge self-hosting (`MANAGED_BRIDGE`); ignored in multi-tenant mode, where one shared topic would leak every un-configured tenant's notifications to a single operator topic. |
| `VITE_API_BASE_URL` | *(unset)* | Build-time API base URL for the web app. Leave blank in dev (the Vite proxy handles `/api`) and for the combined Docker image (the web is served same-origin by the API). Only set it when building the web SPA to be hosted separately from the API. |
