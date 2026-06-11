# PrintStream

## Architecture

- This is a Node.js + TypeScript monorepo with workspaces: `apps/api`, `apps/web`, `apps/bridge`, `apps/slicer`, and `packages/shared`.
- `apps/api` is an Express server that owns persistent MQTT connections to Bambu printers, normalizes their state, and fans out updates over a single WebSocket endpoint at `/ws`. It also handles SSDP printer auto-discovery, print dispatch (queued FTPS upload + MQTT start), camera relay, and printer SD storage browsing.
- `apps/bridge` is the runtime that runs next to the printers and owns LAN access, including **library file storage**. **Library files are bridge-owned by default** (local files are an unsupported fallback), so the bridge — not the API — normally parses 3MFs for the web, via the `library.inspect3mf` RPC. Its parser `apps/bridge/src/library-3mf.ts` is a hand-kept **mirror** of `apps/api/src/lib/three-mf-reader.ts`; changes to the 3MF index shape must be made in both (see `apps/bridge/CLAUDE.md`). The bridge deploys separately from the API.
- `apps/web` is a Vite + React + Joy UI PWA. It loads data through normal HTTP and subscribes to `/ws` for live printer status.
- `packages/shared` holds Zod schemas + inferred types used by both the API and the web app. Do not duplicate request/response shapes elsewhere.
- PostgreSQL via Prisma is the primary datastore. Migrations live under `apps/api/prisma/migrations/`.

## Plugin System (read this before adding a "feature")

The project is built around a plugin system that should be used from day one. Decide early whether new functionality belongs in core or in a plugin:

- **Core** is for capabilities almost every install will want and that are tightly coupled to printer connectivity (status cards, library, jobs, print dispatch, settings shell, transport).
- **Plugins** are for capabilities that some users may not want, or that pull in heavy dependencies, or that integrate with external services (notifications, firmware updates, the 3D model previewer, plate-clearing, future HA/MQTT-relay integrations, etc.).

Built-in API plugins live under `apps/api/src/plugins/<name>/` and implement `ApiPlugin` from `apps/api/src/plugin/types.ts`. They get a sub-router automatically mounted at `/api/plugins/<name>`, plus access to a logger, the Prisma client, the printer event bus, the WS broadcaster, a scoped key/value `Setting` store, and a `registerPrintGuard()` hook.

Built-in web plugins live under `apps/web/src/plugins/<name>/` and implement `WebPlugin` from `apps/web/src/plugin/types.ts`. They can register additional routes and contribute to named extension slots via `<PluginSlot name="..." />`.

Rules:

- A plugin must never import another plugin directly. Cross-plugin coordination happens through events and shared contracts.
- Removing a plugin must never break a core page or route. Code that consumes plugin output (e.g. `<PluginSlot />`) must render gracefully when no plugin is registered.
- Heavy dependencies (Three.js, large parsers, external SDKs) belong in plugins and should be code-split via `React.lazy` (web) or dynamic `import()` (api).
- New API plugin endpoints must validate input with Zod at the route boundary.

See `.claude/guides/plugins.md` for the full plugin contract.

## Open-Core Split (private vs public code)

This monorepo is the **private source of truth**; the public open-source repo is a scripted snapshot (`npm run export:public`) that strips the closed-source cloud surface. Read `docs/open-core.md` before touching anything below.

- Private (cloud-only) code lives in `apps/api/src/private/`, `apps/web/src/private/`, and `packages/shared/src/private/` (consumed as `@printstream/shared/private`). Today this is the marketing site, beta signup, platform overview, and tenant administration.
- Core code must never import from a `private/` directory. The hosts are `apps/api/src/lib/private-modules.ts` and `apps/web/src/lib/privateModules.ts`; core renders fallbacks when no private module is present.
- The core must validate and run with all `private/` directories deleted — that is the public build. When adding cloud-only features, put them in a private module from the start.
- The Home Assistant integration (`integrations/home-assistant/`) publishes to its own HACS repo via `npm run export:ha` and is excluded from the public core snapshot.

## Code Style

- TypeScript everywhere; keep strict mode intact.
- Keep modules focused and small. If a route mixes transport, validation, and business rules, split it.
- ASCII unless the file already needs Unicode.

## Documentation

- Non-trivial modules carry a short JSDoc header that names what they own and any non-obvious invariants.
- Exported symbols whose behavior is not obvious from the name and signature deserve a brief JSDoc.
- It is encouraged to improve docstrings on existing modules you touch even when not explicitly asked to.
- UI conventions are documented in `docs/ui-conventions.md`; backend conventions are documented in `docs/backend-conventions.md`; auth architecture is documented in `docs/auth-architecture.md`; data/event delivery is documented in `docs/data-event-contract.md`; printer driver migration guidance is documented in `docs/printer-driver-migration-plan.md`. Keep the docs and the matching guide files (see below) aligned when those contracts change.

## How project guidance is organized for Claude

- This root `CLAUDE.md` is always loaded.
- Directory-scoped conventions live in nested `CLAUDE.md` files and load automatically when you read or edit files in that subtree: `apps/api/CLAUDE.md`, `apps/api/prisma/CLAUDE.md`, `apps/web/CLAUDE.md`, `apps/bridge/CLAUDE.md`, `apps/slicer/CLAUDE.md`, `packages/shared/CLAUDE.md`.
- Cross-cutting contracts that span several directories live under `.claude/guides/` and are condensed mirrors of the matching `docs/*.md` source of truth. Read the relevant guide on demand using the index below.
- Repeatable workflows are `.claude/commands/` slash commands (`/audit-docs`, `/commit`, `/deploy`, `/install-ha`).

### Domain guides (read the relevant one before related work)

- `.claude/guides/backend-conventions.md` — when working in the API or shared contract code (`apps/api/**`, `packages/shared/src/**`).
- `.claude/guides/ui-conventions.md` — when working in the web app (`apps/web/**`): view layout, directory toolbars, tables, dialogs, pagination.
- `.claude/guides/plugins.md` — when working on the plugin host or any built-in plugin (`apps/api/src/plugin(s)/**`, `apps/web/src/plugin(s)/**`).
- `.claude/guides/auth-architecture.md` — when working on auth identity, sessions, permissions, platform roles, tenant memberships, or support access.
- `.claude/guides/data-event-contract.md` — when working on HTTP loading, WebSocket delivery, workspace context, cache invalidation, or auth-change events.
- `.claude/guides/printer-driver-migration.md` — when working on printer transport, printer contracts, dispatch, discovery, camera, storage, or vendor capability code.
- `docs/slicer-architecture.md` — when working on the slicer area: the 3MF project editor (`apps/web/src/plugins/model-previewer/**`), the CLI slicing pipeline (`apps/api/src/lib/slicing-*`, `apps/slicer/**`), the `SceneEdit` contract, or 3MF read/write (the `three-mf-*.ts` modules behind the `three-mf.ts` barrel).

## Shared Helpers (do not duplicate)

- API HTTP errors: throw `HttpError` (or `badRequest`/`notFound`/`conflict`) from `apps/api/src/lib/http-error.ts`.
- API env: import `env` from `apps/api/src/lib/env.ts`. Do not read `process.env` directly in feature code.
- Prisma: import `prisma` from `apps/api/src/lib/prisma.ts`. Use `rootPrisma` only for deliberate platform-wide operations.
- Prisma tenant scoping: every model with a `tenantId` column must be listed in `TENANT_SCOPED_MODELS` in `apps/api/src/lib/prisma.ts`. Nested `connect`/`include` are not auto-scoped.
- Printer events: subscribe via the `printerEvents` bus from `apps/api/src/lib/printer-events.ts`.
- Printer tenant lookup: `printerManager.getTenantId(printerId)` returns the cached tenant for event-driven code that needs to scope broadcasts or notifications.
- WS broadcasts: always pass an explicit `tenantId` to `ws.broadcast()`. Pass `null` only for deliberate platform-wide events.
- Plugin tenant settings: use `context.settings.forTenant(tenantId)` for per-tenant plugin configuration (webhook URLs, push subscriptions, etc.).
- Web URL building: `buildApiUrl` and `buildWebSocketUrl` in `apps/web/src/lib/apiUrl.ts`. Browser env access goes through `apps/web/src/lib/browserEnv.ts`.
- Web HTTP: `apiFetch` in `apps/web/src/lib/apiClient.ts` instead of bare `fetch` for JSON endpoints.
- Notification formatting: `apps/api/src/lib/notification-format.ts` centralizes event-to-message mapping for all notification channels. Each message includes a `tenantId` so delivery plugins can scope by tenant.
- Library file visibility: `libraryFile` queries that select by anything other than an explicit id must build their `where` through `visibleLibraryFilesWhere` from `apps/api/src/lib/library-visibility.ts` so hidden transient rows and recycled (soft-deleted) rows never leak into listings or name matching.
- Web library uploads: views enqueue through `enqueueLibraryUploads` in `apps/web/src/lib/libraryUploadQueue.ts` (toast progress, pinned destination, survives navigation). `uploadLibraryFileInChunks` is the low-level transport; only single-file flows with their own progress UI (e.g. print-from-local-file) call it directly.
- Print dispatch: `apps/api/src/lib/print-dispatcher.ts` handles queued FTPS upload and MQTT start. Do not bypass it.
- Print guards: `apps/api/src/lib/print-guards.ts` lets plugins gate prints with a reason.
- Error messages from API responses: `extractErrorMessage` from `@printstream/shared`.

## Build And Validation

- Use the devcontainer when possible.
- New non-trivial behavior should add or update focused regression tests in the repo's Node test suite.
- Before finishing a task, run `npm run validate` from the repository root.
- If the Prisma schema changes, regenerate the client (`npm run db:generate`) and update the shared contracts to match.

## Product Conventions

- Mobile-friendly: every UI change must work at phone widths first, then scale up.
- Real-time data flows through WS events fed into TanStack Query caches; do not poll in components.
- Printer commands are fire-and-forget (`POST /api/printers/:id/command` returns 202). The UI should reflect new state through the next status event, not an optimistic guess.
- Treat the LAN access code as a secret: never log it, never include it in error messages or DTOs that surface to the browser unnecessarily.
