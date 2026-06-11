# Configuration reference

See `.env.dev.example` in the workspace root for local development, `.env.server.example` for the server stack, and `.env.bridge.example` for a bridge-only host. Those files intentionally list only the vars a typical install sets; every other key has a working default and can simply be added to your workspace-root `.env` to override. This table is the complete, overridable reference:

| Variable | Default | Description |
|---|---|---|
| `API_PORT` | `4000` | API HTTP port. |
| `NODE_ENV` | `development` | Runtime mode (`development` / `production` / `test`). The Compose stacks set `production`. |
| `DATABASE_URL` | `postgresql://postgres:postgres@db:5432/printstream?schema=public` | Prisma PostgreSQL URL. The default expects the repo's Compose/devcontainer `db` service; use `localhost` or another host only if you run Postgres outside Compose. |
| `DB_WAIT_TIMEOUT_MS` | `60000` | Max time `npm run dev:db` waits for Postgres to accept connections before failing. |
| `DB_WAIT_RETRY_MS` | `1000` | Poll interval `npm run dev:db` uses while waiting for Postgres. |
| `CLIENT_ORIGIN` | `http://localhost:5173` | Comma-separated list of allowed browser origins. |
| `AUTO_CREATE_DEFAULT_WORKSPACE` | `true` | Create a default workspace on first API start when the database has none yet. |
| `DEFAULT_WORKSPACE_SLUG` | `workspace` | Slug of the auto-created default workspace. |
| `DEFAULT_WORKSPACE_NAME` | `My Workspace` | Display name of the auto-created default workspace. |
| `BRIDGE_SERVER_URL` | `http://api:4000` | PrintStream server URL the bridge registers with. The default expects the bridge to reach the API over the same Docker network by service name; override to `http://localhost:4000` when the bridge runs outside Docker. (`BRIDGE_CLOUD_URL` is accepted as a legacy alias.) |
| `BRIDGE_LIBRARY_DIR` | `./data/bridge-library` | Bridge-local directory for library-owned files and dispatch replicas. |
| `BRIDGE_NAME` | `PrintStream Bridge` | Human-readable name used when the bridge registers and is connected to a workspace. |
| `BRIDGE_STATE_FILE` | `./data/bridge-state.json` | Path where the bridge persists its connected identity and runtime token. |
| `BRIDGE_UPDATE_CHANNEL` | `stable` | Release channel used for bridge update checks. |
| `BRIDGE_AUTO_UPDATE` | `false` | When true, the bridge installs an available compatible app-bundle update after registration and restarts through the launcher. |
| `BRIDGE_RELEASES_DIR` | `./data/releases` | Bridge-container directory for staged and activated app-bundle releases. |
| `BRIDGE_RELEASE_RETENTION_DAYS` | `7` | How long to keep rollback releases after the active release has confirmed healthy. |
| `BRIDGE_UPDATE_PUBLIC_KEY` | official PrintStream key | Optional Ed25519 public key override for verifying signed app-bundle updates. Normal bridge installs should leave this unset. Compose `.env` files may use a one-line PEM with `\n` escapes when overriding. |
| API `BRIDGE_RELEASES_DIR` | `./data/bridge-releases` | API-container directory containing signed bridge release JSON fragments and zip assets served to bridges. |
| `CLOUDFLARE_EMAIL_ACCOUNT_ID` | *(unset)* | Cloudflare account ID for Email Sending. Required for local-auth one-time email codes outside demo mode. |
| `CLOUDFLARE_EMAIL_API_TOKEN` | *(unset)* | Cloudflare API token with Email Sending permission. Treat this as a secret and rotate it if exposed. |
| `CLOUDFLARE_EMAIL_FROM_EMAIL` | *(unset)* | Verified sender address for Cloudflare Email Sending. |
| `CLOUDFLARE_EMAIL_FROM_NAME` | *(unset)* | From display name for Cloudflare Email Sending. |
| `AUTH_LOCAL_EMAIL_CODE_TTL_MINUTES` | `15` | Expiry window for local-auth one-time email codes. |
| `LIBRARY_DIR` | `./data/library` | Directory where uploaded `.3mf`/`.gcode`/`.stl` files are stored. |
| `LIBRARY_MAX_UPLOAD_BYTES` | `1073741824` | Maximum accepted library upload size in bytes (default 1 GiB). |
| `LIBRARY_TRANSIENT_RETENTION_DAYS` | `7` | How long hidden transient library uploads are retained before scheduled cleanup removes them. |
| `LIBRARY_RECYCLE_RETENTION_DAYS` | `30` | How long recycle-bin (soft-deleted) library files stay restorable before scheduled cleanup removes them permanently. |
| `LIBRARY_UNREFERENCED_SLICE_RETENTION_HOURS` | `24` | How long unreferenced sliced outputs (never saved to the library or snapshotted for print history) are kept before cleanup removes them. |
| `SLICER_SERVICE_URL` | *(unset)* | Optional URL for the standalone slicer container. Set to enable server-side slicing orchestration. |
| `SLICER_SERVICE_TOKEN` | *(unset)* | Optional bearer token shared between the API and slicer container. Treat this as a secret. |
| `SLICER_BIND_HOST` | `127.0.0.1` | Host interface for the published slicer port in Compose (`127.0.0.1` keeps it private to the server). |
| `SLICER_BIND_PORT` | `4010` | Host port mapped to slicer container port `4010` in Compose. |
| `SLICING_MAX_CONCURRENT_JOBS` | `1` | Maximum number of slicing jobs the API will run against slicer workers at once. |
| `SLICING_MAX_QUEUED_JOBS` | `10` | Maximum number of queued slicing jobs waiting for a concurrency slot. |
| `SLICING_REQUEST_TIMEOUT_MS` | `1800000` | Timeout for API-to-slicer requests. |
| `SLICER_DEFAULT_TARGET_ID` | *(first installed target)* | Override the default slicer version shown in the slice dialog. Must match an `id` from the built-in target manifest (`/opt/printstream-slicers/targets.json`). |
| `SLICER_ENABLE_PIPE_PROGRESS` | `true` | When `true`, append Bambu/Orca CLI `--pipe` progress JSON frames into slicing job output so the UI can render determinate progress updates. |
| `SLICER_BAMBUSTUDIO_HOME_DIR` | under slicer work dir | Isolated home directory used when launching BambuStudio. Subdirectories are created per target id. |
| `SLICER_BAMBUSTUDIO_DATA_DIR` | under slicer work dir | Persistent `--datadir` used for slicer presets and first-run state. Subdirectories are created per target id. |
| `PRINT_JOB_THUMBNAIL_RETENTION_DAYS` | `90` | How long completed-job thumbnail PNGs and persisted final-frame snapshot JPGs are retained before scheduled cleanup removes them. |
| `PLUGINS_DIR` | `./data/plugins` | Directory for installed external plugins. |
| `TRUST_PROXY` | *(unset)* | Express `trust proxy` setting; set when behind a reverse proxy. |
| `TENANT_DOMAIN_SUFFIX` | *(unset)* | Tenant-routing suffix for multi-workspace installs; e.g. with `example.com`, requests to `acme.example.com` resolve to the `acme` workspace. |
| `DEFAULT_TENANT_SLUG` | *(unset)* | Optional demo-data tenant slug hint. Anonymous requests do not fall back to a tenant automatically. |
| `DISCOVERY_PORT` | `2021` | UDP port the bridge uses for SSDP printer auto-discovery. |
| `PUBLIC_BASE_URL` | *(unset)* | Absolute URL used for notification media embeds (e.g. camera snapshots). |
| `MQTT_DEBUG_LOGS` | `false` | Set to `true` or `1` to log raw MQTT publish/receive traffic for protocol debugging. |
| `CAMERA_DEBUG_LOGS` | `false` | Set to `true` or `1` to re-enable verbose RTSP camera readiness logs such as `snapshot ready` and `first frame`. |
| `NTFY_TOPIC_URL` | *(unset)* | Default ntfy topic for the notifications-ntfy plugin. |
| `VITE_API_BASE_URL` | *(unset)* | Build-time API base URL for the web app (leave blank in dev to use the Vite proxy). |
| `VITE_DOMAIN_MIGRATION_TARGET` | *(unset)* | Temporary old-domain-only setting that builds a self-destroying service worker and redirects every page load to the new origin. |
