# Architecture — printstream

## High-level flow

`apps/web` is the only client surface: a Vite-built React PWA styled with Joy UI. It loads data through normal HTTP and holds one authenticated WebSocket connection to `/ws` for live printer updates. There is no separate desktop app and no native mobile app; a Capacitor wrapper around the same web bundle is the planned path to an installable Android shell.

The web root route goes straight into the app: protected routes resolve auth/bootstrap state and route actors to the platform workspace, workspace chooser, or tenant workspace as appropriate. Tenant stats remain available at `/workspaces/<slug>/stats`. If sign-in is required for a protected route, the auth UI renders above the normal shell at the URL the user originally requested instead of redirecting the browser to a separate auth route first.

`apps/api` is an Express server that owns:

- The server/control-plane side of printer connectivity, including direct local MQTT sessions for non-bridged printers and bridge-session ingestion for printers managed through a remote bridge.
- A normalization layer that converts Bambu's `report` payloads into a stable, web-friendly `PrinterStatus` contract defined in `packages/shared`, including per-nozzle readings, AMS state, external spool state, layer progress, per-light capabilities/state, air-management mode, printer settings, and other model-specific status when the printer reports them. AMS slots and external spools carry both a primary tray color and a normalized `colors[]` palette so the web UI can render Bambu multi-color spools and resolve material-aware filament names, plus the currently selected pressure-advance calibration index and reported K value.
- A **single WebSocket fan-out** at `/ws` so every connected client sees the same stream.
- The HTTP REST surface for printers, library, jobs, camera, logs, notifications, print dispatch, and plugin administration.
- An optional **auth + authorization core** for session cookies, provider bootstrap, user/group/service-account management, and permission-gated routes.
- A **plugin host** that gives both built-in and third-party plugins a stable extension point.
- The bridge registration/session control plane used by outbound `apps/bridge` runtimes.
- A **print dispatcher** that queues, uploads (via FTPS), and starts prints with per-printer serialization, AMS mapping, plate selection, and cancellation support.
- A **delete-operation dispatcher** that queues library-file and printer-storage deletes in the API process so progress survives dialog closes, route changes, and browser disconnects.
- A shared camera proxy that coalesces snapshot requests and multiplexes live camera streams so multiple browser clients do not multiply printer camera connections. The bridge-runtime retains a source-side frame limiter, but it is disabled by default; RTSP streams use ffmpeg passthrough sync so ffmpeg does not synthesize duplicate MJPEG frames.
- A **print guard** registry that lets plugins gate print starts (e.g. plate-clearing confirmation).
- A PostgreSQL database via Prisma for persistent printer config, print history, trigger-maintained production stats, library metadata, folder hierarchy, installed plugins, and a generic key/value `Setting` table.

The product now operates in two workspace modes:

- **Platform workspace:** tenantless host context used for platform Admin authentication, tenant provisioning, platform plugin policy, and platform logs.
- **Tenant workspace:** a tenant-selected context used for printers, library, jobs, notifications, tenant auth, and tenant-local settings.

`/api/auth/bootstrap` returns both the current workspace and the tenant choices the current actor can switch into. The web shell uses that to decide whether it should render the platform routes or the tenant routes.

`apps/bridge` is an outbound runtime that lives on the printer LAN when the API/web stack is hosted elsewhere. It owns SSDP auto-discovery, printer-local MQTT/FTPS/camera transport for bridged printers, bridge-local library copies, and a single outbound bridge session back to the API. Bridge-hosted library files keep their full bytes on the bridge by default; the API caches small derived artifacts such as parsed 3MF plate metadata and thumbnail PNGs under its library data directory so repeated library browsing does not repeatedly cross the slow bridge session. The API only materializes a full bridge file copy locally when a path truly needs local bytes, such as print/slice preparation or fallback parsing after bridge-side metadata extraction is incomplete. Because library files are bridge-owned by default, the bridge's 3MF parser (`apps/bridge/src/library-3mf.ts`) is the one that normally produces the plate/object index the web sees; both it and the API's `apps/api/src/lib/three-mf-reader.ts` (used for the local/fallback parse; scene assembly and slice-time 3MF rewriting live in the sibling `three-mf-scene-builder.ts`/`three-mf-output.ts`) build that index from one shared parser, `@printstream/shared/three-mf`, so a change to the parsed index shape is made once there and gated by a single `THREE_MF_INDEX_PARSER_VERSION` bump that both apps' caches derive from. When a bridge is replaced, the API can recover printer assignments by matching rediscovered serials from the connected bridge against tenant printers that are orphaned or still assigned to a disconnected bridge. The public bridge runtime image excludes the API and web application directories.

`packages/shared` holds the typed contracts (Zod schemas + inferred TS types) used by the API, bridge runtime, and web app. It is the source of truth for HTTP DTOs, auth/provider contracts, WS event shapes, bridge RPC contracts, notification types, and shared error helpers.

## Layers

| Layer | Description |
|---|---|
| `apps/web` | Mobile-friendly React + Joy UI PWA shell, page routes, WS subscription, plugin host. |
| `apps/api` | Express HTTP routes, bridge session server, printer manager, WS broadcaster, Prisma persistence, plugin host. |
| `apps/bridge` | Outbound LAN runtime for SSDP discovery plus bridged MQTT/FTPS/camera transport. |
| `apps/slicer` | Standalone runtime that wraps the BambuStudio CLI to slice 3MFs on request from the API. |
| `packages/shared` | Zod schemas, DTOs, WS + bridge event contracts, notification types, error helpers. |
| `packages/bridge-runtime` | Shared LAN transport library (MQTT, FTPS, camera, SSDP discovery, transport arbitration) used by both `apps/api` and `apps/bridge`. |
| `packages/sea-runtime` | Generic, app-agnostic Node SEA plumbing (service install, paths, control channel, tray, build harness) for standalone single-executable packaging. |
| `apps/api/prisma` | PostgreSQL schema + migrations. |

## Live data flow

```
Printer --MQTT--> printer-manager --> printerEvents bus --> ws-server --> /ws --> web
                                              |
                                              +--> print-job-recorder --> Prisma PrintJob
                                              |                         +--> TenantStats / PrinterStats / PlatformStats rollups
                                              +--> plugins (notifications, plate-clearing, ...)
```

The MQTT client emits parsed events on a typed `PrinterEventBus`. The WS broadcaster and any subscribed plugins consume from that bus. Plugins **never** parse raw MQTT payloads themselves; they only see the normalized `PrinterStatus` and the lifecycle events (`job.started`, `job.finished`, `printer.added`, `printer.updated`, `printer.removed`). If a printer connection remains offline after normal MQTT reconnect attempts, the manager recreates that printer's client so firmware resets and LAN interruptions do not leave a stale disconnected client behind.

The web client validates every incoming WS payload with `wsEventSchema` and writes status updates into workspace-scoped React Query caches (`workspaceQueryKeys.printerStatus(scopeKey)`). Resource-change events also invalidate adjacent caches such as printer views, notification templates, jobs, and plugin settings so dashboard configuration changes propagate without a reload. UI components read from those caches; printer status does not poll. The Jobs surface then classifies persistent `PrintJob` rows by lifecycle: queued/uploading dispatch work is folded into the in-progress section alongside unfinished `PrintJob` rows and live status frames, while finished rows render the history view.

Delete operations follow the same "server owns the long-running work" rule as print dispatch. Browsers start a job through the normal library/printer-storage routes, the `DeleteOperationDispatcher` executes it in-process with per-target queueing, `GET /api/delete-operations` exposes progress snapshots, and coarse `resource.changed` events for `delete-operations`, `library`, and printer storage prompt the web app to refresh any affected views. The web renders those jobs through a small global toast stack rather than tying progress to the lifetime of the initiating dialog.

## Print dispatch flow

```
Library file --> 3MF metadata parse --> compatibility guard --> print-dispatcher --> print-guards check
                                                                             |
                                                                       FTPS upload to printer SD
                                                                             |
                                                                       MQTT project_file command --> printer starts
```

The dispatch path parses 3MF metadata before upload so the API can enforce the same printer-model, plate-type, nozzle-diameter, and tray/material compatibility rules that the web UI shows. Direct dispatch is intentionally limited to `.gcode` and `.gcode.3mf`; plain `.3mf` projects remain inspectable in the library but are not started directly. Before upload, the dispatcher now snapshots the selected library artifact into a hidden retained `LibraryFile` row keyed by file content so later reprints still resolve even if the visible library entry is edited or deleted, while repeated prints of the same file version reuse the existing snapshot instead of copying bytes again. If a print request references a library row or retained snapshot still owned by a disconnected bridge, the API may resolve it to the single matching visible file on a connected bridge before snapshotting; ambiguous or missing matches continue through the normal error path. Just before the MQTT start command is published, the dispatcher creates or refreshes a persistent unfinished `PrintJob` row for that dispatched job, then emits `print.dispatch.starting` so plugins like plate-clearing know the print originated locally. Printer-manager lifecycle events still reconcile the real job start/finish edges, but if connectivity drops and later returns with the printer already back in a terminal stage, the recorder closes the latest unfinished row using the last known terminal state so stale active jobs move cleanly into history. The `PrintDispatcher` still serializes uploads per-printer, supports multi-plate 3MF extraction, tray mapping, model-gated print options including printer-native nozzle-offset calibration modes, bounded FTPS upload retry, and cancellation before the MQTT start command. For multi-plate jobs it preserves the selected plate name in the generated printer-side remote filename / subtask name so the printer UI and SD-card browser stay unambiguous. App-dispatched 3MF jobs also register a short-lived local-source mapping so follow-up cover extraction and skip-object preview reads can reuse the already-local archive instead of fetching the same file back from printer storage. Dispatch status is tracked in-memory and exposed via `/api/print-dispatch`; failed dispatches can be retried while the API process still has the job metadata.

Server-side slicing for unsliced Bambu Studio `.3mf` files is routed through a separate slicer runtime/container rather than the API or bridge process. The API validates tenant-owned source files, exposes tenant-scoped custom BambuStudio preset persistence in Settings > Slicing, merges those uploaded printer/process/material presets with slicer-target built-ins when populating the slice dialog, lets users choose either a real printer as a slicer-context preset or a manual profile, enforces bounded FIFO queueing, persists saved slice results back into the visible library, stores print-flow slice outputs as hidden transient library artifacts so the follow-on print can use them without cluttering the library browser, replaces an existing same-name file (with version archiving) when a kept output is saved over it, and snapshots job-owned thumbnail media so slicing history survives later library cleanup or manual source-file deletion. The slicer runtime owns BambuStudio CLI execution, output capture, cancellation, and artifact generation, including materializing selected built-in or custom preset JSON files and post-processing packaged `.gcode.3mf` outputs so saved artifact metadata reflects the selected printer/process/material target rather than stale source-project metadata. It runs on the PrintStream server alongside the API, not next to the bridge; the bridge runtime itself does not absorb slicer responsibilities.

## Camera flow

Printer-card snapshots use `/api/camera/:printerId/snapshot`, but the browser no longer owns the 5-second cadence. Instead, visible snapshot tiles declare interest over `/ws`; the API tracks those per-printer watchers, keeps a short per-printer snapshot cache, and runs a fast refresh loop while at least one connected client is actually watching that printer tile. When no client is watching, the API does not stop polling entirely: it keeps a slow background refresh (every ~20 seconds, staggered across printers) running for every online camera-capable printer so the shared cache stays reasonably fresh and a user returning to the app after an extended absence sees a recent frame instead of a stale one. The background loop tracks printer online state via `status`/`printer.removed` events and tears down when a printer goes offline or is removed. Each refresh updates the shared cache, broadcasts a `camera.snapshot.updated` event, and interested browsers then reuse that cached frame through the normal HTTP snapshot route. That keeps snapshot polling client-aware without multiplying printer-side camera reads.

For P1/A1 models the underlying camera read is the proprietary TLS JPEG stream; for X/X2/H models it is an ffmpeg-backed RTSP(S) proxy. Live camera dialogs still subscribe over `/ws`; `CameraRelay` multiplexes all viewers of the same printer over one shared printer camera stream with a short grace period after the last subscriber leaves. The bridge-runtime keeps a configurable source-side frame limiter, but the default path currently forwards every yielded frame. RTSP stream output uses ffmpeg passthrough sync (`-vsync 0`) so ffmpeg does not synthesize duplicate MJPEG frames before they cross the bridge/API boundary. Bambu RTSP cameras periodically reset/wrap their RTP timestamps (and at low frame rates emit frames sharing a timestamp), which surfaces as non-monotonic pts/dts and aborts the mjpeg encoder/image2pipe muxer; the output rewrites each frame's PTS from its frame index (`-vf setpts=N/TB`) so the encoder and muxer always see a strictly increasing timestamp (the bridge re-splits the output into JPEG frames by SOI/EOI markers, so the source timestamp values are irrelevant downstream). Because frames cross printer -> bridge (LAN) -> API (server) before fan-out, they arrive at the API hub in bursts followed by gaps; `CameraStreamHub` runs each upstream stream through an adaptive playout buffer (`paceCameraFrames`) that re-emits frames on a smoothed, EMA-derived cadence so playback looks steady, trading a small bounded amount of latency (frames are never held past a max-latency cap, never dropped, and never reordered) for smoothness. Snapshot refreshes also reuse the latest live-stream frame during that grace window instead of forcing a second printer-side read, which reduces reconnect churn on printer families that are sensitive to repeated open/close cycles. Bridge-local transport arbitration pauses TLS snapshot and live camera reads while printer FTPS work is active; RTSP camera reads do not share that transport lock. The bridge/API still propagate FTPS activity as a tenant-scoped `printer.ftps.active` event so the web UI can show when printer storage work is active.

Active print-cover thumbnails follow a similar pattern on the API side: the extracted PNG is cached on disk, alias keys derived from live job metadata are persisted alongside the cache, and the web keeps the current thumbnail visible until a newly requested cover has actually loaded. When the print originated from PrintStream, the API can reuse the local dispatched 3MF for both cover extraction and skip-object preview reads before falling back to FTPS; those previews now prefer embedded `Metadata/pick_N.png` picking masks and only fall back to parsed first-layer geometry when no mask is present. Printer-storage 3MF inspection also uses a short-lived shared inspection cache, cached FTPS directory listings, and partial remote ZIP reads when the needed metadata lives near the end of the archive, so thumbnail and plate-metadata requests do not redownload the same full archive back-to-back. That avoids repeat FTPS lookups for already-known jobs and prevents brand-new jobs from flashing an empty cover tile before the first image arrives.

## Plugin system

The plugin system is part of the foundation, not an add-on. The motivation is simple: most "features" are optional for some users (push notifications, 3D preview, firmware updates, Discord/Home Assistant bridges). Building these as plugins from day one prevents the code base from sliding into a monolithic core that has to grow flags and conditionals for every integration.

### API plugins

- Contract: `ApiPlugin` in `apps/api/src/plugin/types.ts`.
- Built-ins live under `apps/api/src/plugins/<name>/` and are registered in `apps/api/src/plugin/builtin.ts`.
- Plugins declare `runtimeSurfaces` (`platform`, `tenant`, or both), `managerSurfaces`, and `tenantAccess` so the host can keep platform-only features out of tenant workspaces and vice versa.
- Each plugin receives a scoped `router` automatically mounted at `/api/plugins/<name>`, a scoped key/value `settings` store backed by the `Setting` table, a `logger`, the `PrinterEventBus`, the WS broadcaster, the Prisma client, plus `registerPrintGuard()` and `registerAuthProvider()` hooks.
- Plugins must register cleanup with `context.onShutdown(...)` for any subscription or external connection.
- Plugins must not import each other.
- Third-party plugins can be uploaded via `/api/admin/plugins/upload` and are installed into `PLUGINS_DIR`.

The platform-facing plugin APIs are split intentionally:

- `/api/admin/plugins` is the privileged platform manager for install/uninstall and tenant-availability policy.
- `/api/plugin-catalog` is the current-workspace catalog used by the web shell to decide which routes, slots, and tenant plugin toggles are available without exposing the full admin API.

### Web plugins

- Contract: `WebPlugin` in `apps/web/src/plugin/types.ts`.
- Built-ins live under `apps/web/src/plugins/<name>/` and are registered in `apps/web/src/plugin/builtin.ts`.
- A plugin can:
      - Register **routes** mounted alongside the core routes in `App.tsx`.
  - Contribute **slot components** to named extension points exposed by core pages via `<PluginSlot name="..." context={...} />`. Slots receive a free-form `context` object and must render `null` when their prerequisites are not met.
      - Contribute **static slot components** to auth/setup shells that render before plugin-manager state is available.
      - Provide a **settings panel** component rendered by the workspace plugin manager when the plugin is selected.
  - Run an **init** function on startup (returning an optional cleanup callback).
- Plugins must not import each other.

### Built-in plugins

| Plugin | Side | Description |
|---|---|---|
| `auth-local` | API + web | Passkey and one-time email-code sign-in for local operators, including first-run bootstrap, self-service account security, admin-visible passkey management, and recent-verification flows for sensitive actions. |
| `auth-oauth` | API + web | Generic OpenID Connect authorization-code + PKCE provider with configurable issuer/client settings, verified-email matching to auth users, and first-user Admin bootstrap when the installation has no auth users yet. |
| `firmware-updates` | API + web | Checks installed firmware against the Bambu wiki plus the firmware-download feed, caches those upstream lookups, downloads a selected release, uploads it to printer SD via FTPS, retries installed-version reads after reconnect or when firmware state is queried before a version reply arrives, and reconciles stale "ready to install" / "Update" state when the file disappears or the printer is already updated. Shows an "Update" chip on printer cards when outdated. |
| `home-assistant` | API + web | Publishes a printer + AMS bootstrap snapshot with cover/camera paths plus live plugin events for the companion Home Assistant custom integration, and adds a setup guide surface in the web app with Lovelace card examples plus Home Assistant-side image/media surfaces. The HA package bootstraps from the snapshot, follows `/ws` updates in real time, registers printer/AMS control services, supports multiple Home Assistant config entries against different tenant workspaces, and turns that data into model-aware printer, AMS, tray, external-spool, and image entities without registering unsupported capabilities on incompatible hardware. |
| `notifications-browser` | API + web | Web Push via VAPID keypair (auto-generated). The service worker (`push-handler.js`) fires OS notifications even when the app is closed. |
| `notifications-discord` | API + web | Posts printer notifications to a configured Discord webhook. |
| `notifications-ntfy` | API + web | Forwards printer notifications to a configured ntfy topic URL. |
| `orders` | API + web | Production order templates with named variants, per-copy filament-color override snapshots, required-print expansion, tracked per-print lifecycle, and an app-relative `/orders` workflow mounted under a tenant workspace slug. Template items may reference unsliced project 3MFs; starting one slices first (web slice-then-print flow) and dispatches the sliced output via `slicedFileId` while the item keeps pointing at the source 3MF. |
| `plate-clearing` | API + web | Gates prints behind a "plate cleared" confirmation. After a print finishes the printer is blocked until the user confirms. External prints bypass the gate. |
| `model-studio` | API + web | Three.js viewer + multi-plate 3D editor for STL, plated 3MF, and plated G-code library files: per-plate thumbnails and modal preview entry points wired into library actions/dialogs, plus an "Edit in 3D" slice-dialog editor and a "New 3D project" library action that import/arrange models (footprint-aware auto-arrange, auto-orient, primitives, split-to-objects, multi-select with assemble), edit materials, add negative parts / modifiers / support blocker and enforcer volumes, paint supports/seam/colours (Bambu-style circle/sphere brushes, smart/bucket fill, height range, edge detection, on-overhangs-only), place manual brim ears, schedule per-layer filament changes, toggle per-object printability (BambuStudio's "Printable", excluded from the slice but kept in the saved 3MF), and save new or edited 3MFs back to the library. |

Built-in plugins register with different defaults: `auth-local` and `auth-oauth` are always installed and enabled and are available to every workspace (they back the platform's own sign-in); `model-studio` is enabled by default; and the remaining built-ins (the notification channels, `plate-clearing`, `firmware-updates`, `orders`, and `home-assistant`) register disabled until a workspace enables them. Existing installs keep their prior effective enabled state unless they have explicit plugin settings already stored.

All notification plugins share `apps/api/src/lib/notification-format.ts`, which maps printer events (`job.started`, `job.finished`) onto a single `NotificationMessage` contract from `packages/shared`. Notification messages are rendered through user-customizable templates managed via `/api/notifications/templates`. Adding a new trigger only needs a branch in the formatter — every channel picks it up automatically. Plugins still must not import each other; the helper lives in `lib/`.

### When to write a plugin vs. core code

Plugin when the feature is optional for some installs, pulls in heavy dependencies, talks to an external service, or is an obvious extension surface. Core when it is required for the basic product loop (printer connectivity, status display, library, jobs, settings shell, transport).

## HTTP API surface

| Mount | Purpose |
|---|---|
| `/api/health` | Health check |
| `/api/auth` | Auth bootstrap, browser-session lifecycle, current-account profile, auth roles/users/service accounts, and session policy |
| `/api/stats` | Tenant setup-readiness and high-level workspace production metrics for the stats page |
| `/api/printers` | Printer CRUD, reorder, add-printer LAN/developer-mode validation, calibration / filament commands, pressure-advance profile history/select/create/delete flows, light and air-management controls, cover images, SD storage browsing, SD-file preview/download routes, AMS settings/drying commands, and printer-storage 3MF metadata |
| `/api/printer-views` | Saved Printers-page view definitions (printer subset, cards-per-row, sort mode, per-card content visibility) restored as named dashboard layouts |
| `/api/library` | Chunked file upload/download with upload-session progress through bridge transfer, folder tree, overwrite-aware version history, plates/thumbnails, history restore, and print dispatch |
| `/api/jobs` | Persistent print-job lifecycle rows used for active jobs and history |
| `/api/slicing` | Server-side slicing requests; validates source files and optional printer targets, then queues the BambuStudio CLI (which runs in the separate slicer runtime) |
| `/api/editor` | 3D plate-editor support: staging imported STL/STEP geometry and persisting `SceneEdit` project edits |
| `/api/camera` | Camera snapshots and stream relay |
| `/api/logs` | Platform or tenant log viewer and clearing, combining durable audit entries with in-memory system diagnostics |
| `/api/settings` | Core app-level settings shared across devices (currently general layout preferences) |
| `/api/notifications` | Notification template CRUD and snapshot images |
| `/api/delete-operations` | Background delete-job list + progress snapshots |
| `/api/print-dispatch` | Active print dispatch queue, cancellation, and retry |
| `/api/bridges` | Tenant bridge management: listing plus the connect/rename flows that attach dormant bridge records to a workspace |
| `/api/bridge-runtime` | Bridge runtime bootstrap: bridges register here to receive a durable machine credential and a short pairing code before they are connected to a workspace |
| `/api/admin/plugins` | Platform-only plugin listing, install/uninstall, enable/disable, and tenant availability policy |
| `/api/plugin-catalog` | Current-workspace plugin catalog used by the web shell and tenant settings |
| `/api/plugins/<name>` | Per-plugin routes (managed by the plugin host) |

## Persistence

PostgreSQL via Prisma. The default development and deployment convention is a Compose-managed `db` service reached through `postgresql://postgres:postgres@db:5432/printstream?schema=public`, while API-owned files such as the library and plugin storage remain under `LIBRARY_DIR` / `PLUGINS_DIR`.

| Model | Purpose |
|---|---|
| `Tenant` | Hosted workspace directory and routing identity. The API ensures a canonical `Default` tenant exists for owner-mode installs, but platform mode remains tenantless until a selection is made. |
| `Printer` | Registered printer connection config plus saved hardware fallback state (current plate type, installed nozzle diameters) and dashboard sort position. |
| `Bridge` | Registered LAN bridge runtime: workspace pairing (`connectCode` / `runtimeTokenHash`), version and update-channel state, and last-seen heartbeat. Owns the printers, library files/folders, and file replicas stored on that bridge. |
| `PrinterView` | Saved Printers-page view definitions per tenant (printer subset, cards-per-row, state/model/nozzle/plate filters, sort, and per-card content settings) surfaced through `/api/printer-views`. |
| `PrintJob` | Persistent print-job lifecycle rows. PrintStream dispatches create unfinished rows before the MQTT start command, externally-started jobs still materialize from printer lifecycle discovery, and later lifecycle/status reconciliation closes rows into history. Dispatch-originated jobs retain file, plate, AMS, and `sourceType` metadata, which distinguishes normal library prints from calibration routines and lets the web render richer active/history/replay affordances, and completed jobs can persist a job-owned final camera frame via `snapshotPath` for later history and notification reuse. |
| `TenantStats` | Tenant-scoped lifetime production totals maintained by database triggers when print jobs finish. Includes total/success/failed/cancelled print counts, successful and wasted print durations, and filament totals only for jobs whose usage can be resolved. |
| `PrinterStats` | Per-printer lifetime totals keyed by tenant and printer serial, so stats survive deleting and re-adding the same physical printer. These are recorded once at job finish by the print-job recorder. |
| `PlatformStats` | Singleton platform-wide rollup maintained from tenant stats and workspace membership/printer counts for efficient platform overview loading. |
| `LibraryFile` | Metadata for the current visible library entry. API-owned bytes live on disk under `LIBRARY_DIR`; bridge-owned bytes live on the owning bridge, with API-side derived metadata/thumbnail caches for fast browsing. Supports a `hidden` flag for transient uploads plus retained deduplicated snapshot rows used to keep dispatched-job reprints stable. Soft deletes set `deletedAt` (recycle bin; restorable until the retention window expires), `origin` tags the row lifecycle ('upload'/'slice'/'scaffold'/'snapshot') for cleanup windows, and `createdBy*`/`restoredFromVersionNumber` record version attribution and restore provenance. Same-name uploads within the same folder now overwrite this current row in place so existing references stay stable. |
| `LibraryFileVersion` | Archived historical revisions captured whenever a visible library file is overwritten or an older revision is restored as current. Stores the prior storage pointer and metadata so the UI can list history, download older revisions, print older revisions, or restore one as the new current version. |
| `LibraryFolder` | Hierarchical folder tree for organizing library files (self-referencing parent). |
| `LibraryFileReplica` | Tracks a copy of a library file materialized on a specific bridge (stored path, size, content hash, replica kind, and sync `status`) with verification/access timestamps and an optional cache `expiresAt`. |
| `AuditLog` | Durable audit trail for mutating requests, including actor, workspace, action summary, resource, and status code. Platform logs and tenant logs both read from this table. |
| `AuthUser` / `AuthTenantMembership` / `AuthGroup` | Human auth identities use one global user record per email, tenant-scoped memberships carry login disablement and workspace access, and groups remain tenant-scoped reusable role definitions. |
| `AuthSession` | Browser session secrets, user-agent metadata, and revocation / expiry tracking for signed-in users. |
| `AuthServiceAccount` | Bearer-token automation identities with role-based memberships. |
| `AuthPasskeyCredential` / `AuthEmailCodeToken` | Provider-owned local-auth credentials and short-lived one-time email-code records. |
| `Setting` | Generic key/value store used by plugin settings (keys namespaced as `plugin:<name>:<key>`) and core configuration. |
| `Plugin` | Metadata for externally installed (uploaded) plugins (name, version, source, install path, entry point). |
| `OrderTemplate` / `OrderTemplateVariant` / `OrderTemplatePrint` | Reusable production-order templates with named variants plus the required library file, plate, quantity, and notes for each template line. |
| `Order` / `OrderVariantSelection` / `OrderPrint` | Snapshot of an order created from a template, the variant quantities selected for that order, and the individual tracked print units. Each order print can also persist a per-copy project-filament override snapshot so later AMS mapping shows the chosen colors instead of the source model colors. |

Stats are durable lifetime counters rather than a live scan of history rows. `TenantStats` and `PlatformStats` are updated by PostgreSQL triggers, while `PrinterStats` is claimed atomically from the recorder so retries cannot double-count a finished job. Print-job deletion and printer removal do not subtract already-recorded production totals.

The API also runs a small maintenance loop at startup and then daily. It prunes expired cover-cache artifacts, ages out transient hidden library uploads, clears old completed-job thumbnails plus persisted final-frame snapshots, and removes stale bridge-derived metadata/thumbnail cache files so those convenience caches cannot grow on disk forever.

Plugin-specific state should live in the `Setting` table by default. A plugin that genuinely needs its own tables should be promoted out of the core schema in a follow-up rather than growing the core schema.

## Web app pages

| Page | Description |
|---|---|
| Platform settings | Platform authentication, platform plugin policy, and platform logs. |
| Tenant stats | Workspace stats page with setup readiness, quick-start tasks, and persisted tenant production totals. Tenant workspaces now land on Printers by default, with stats available at `/workspaces/<slug>/stats`. |
| Printers (dashboard) | Live printer cards with camera/cover thumbnails, metrics, per-nozzle readouts, AMS units, AMS settings/drying controls, external spools, calibration controls, AMS pressure-advance profile management, printer-storage browsers, plugin extension slots, and a dedicated per-printer detail route with printer-specific stats and history. Configurable cards-per-row and state filters. |
| Library | File browser with folder hierarchy, staged upload progress for browser-to-server and server-to-bridge transfer, overwrite-aware file history, download, metadata chips from parsed 3MFs, plates/thumbnails, compatibility-aware print dispatch, older-version print/restore actions, batch selection for move/delete, background delete progress toasts, destructive-action confirmation, and plugin actions. |
| Jobs | One in-progress section that combines queued dispatches and active prints backed by unfinished persistent jobs plus live status and live camera/snapshot media, and chronological print plus slicing history with reprint shortcuts plus durable job-owned media that can survive later library cleanup. |
| Auth | Provider-contributed sign-in UI that renders in place whenever the current route requires auth; `/auth` remains an entry route, but the normal flow keeps users on the URL they originally requested. |
| Account | Self-service account page at `/workspaces/<slug>/account` or `/platform/account` for current-profile edits, browser-session review, and provider-owned account-security controls. |
| Orders | Built-in app-relative plugin route mounted under `/workspaces/<slug>/orders` for order templates, production orders, per-print tracking, and completion/confirmation actions. |
| Logs | Structured log viewer that can show audit and system entries, with level filters applied only to system logs. |
| Settings | Tenant-scoped configuration, including local auth access management, tenant plugin toggles, notifications, and tenant logs. |

## FTPS behavior

Printer-side file access is intentionally serialized per printer in `printer-ftp.ts`. Dispatch uploads, printer-storage downloads, cover extraction, and firmware uploads all share that queue so Bambu printers are not hit with overlapping FTPS sessions from the same server process. The bridge runtime also treats active FTPS work as a transport lock for TLS chamber-camera access, so P1/A1-family snapshot and live-stream reads wait or pause until the printer-side storage session settles; RTSP camera reads use a separate transport and do not pause for FTPS activity. The FTPS helper also overrides the firmware's broken PASV host advertisement (`0.0.0.0`) by reusing the control-connection host for data transfers, caches directory listings briefly, and exposes targeted suffix reads for ZIP-backed 3MF inspection so printer-storage browsing and firmware uploads work reliably across models without paying the cost of a full archive download for every metadata lookup. Buffer-returning suffix downloads are additionally capped by size and limited in concurrency so multiple printers cannot spike process heap with large simultaneous ZIP reads.

## Security posture

- The LAN access code is a secret. It is stored in PostgreSQL and is sent over MQTT to the printer; it is not exposed to the browser unless explicitly required by a feature.
- A paired bridge is trusted (it receives printer configs including LAN access codes), and bridge registration is unauthenticated by design. Single-host self-hosts can run **managed-bridge mode** (`MANAGED_BRIDGE`), where the API auto-pairs the bundled bridge and hides every bridge-management surface; pairing is authenticated by a provisioning token the API generates and shares with the bundled bridge through a private mounted file (`MANAGED_BRIDGE_TOKEN_FILE`), so it never traverses the network and an attacker who can reach the register endpoint cannot claim the bridge slot. Cloud and remote-bridge installs leave this off and pair by connect code.
- The API uses `helmet` defaults but disables strict CSP and CORP because it proxies binary streams (camera, library downloads).
- The API applies fixed-window request throttles in middleware: a coarse pre-auth API bucket runs before body parsing, and actor-aware auth/read/write buckets run before route handlers. Multi-replica or internet-facing deployments should still pair this with an upstream or shared rate limiter.
- Auth is plugin-provided. The built-in `auth-local` and `auth-oauth` providers are always installed and enabled and available to every workspace (they back the platform's own sign-in); what an operator configures is each provider's settings (open local sign-in, OAuth client credentials, and so on), not whether the plugin is enabled.
- The project is still LAN-first. If auth is disabled, or if you expose the app beyond your trusted network, put it behind TLS and an upstream reverse proxy you control.

## Future direction

- **Capacitor wrapper:** Reuse the existing web build as an installable Android app shell.
- **Plugin discovery:** Optional dynamic plugin loader (npm package convention or filesystem scan) layered on top of the existing registry without changing plugin signatures.
- **Hosted hardening:** Extend the current auth/session model with stronger internet-facing deployment guidance, recovery flows, and public-hosting ergonomics beyond the current LAN-first posture.
