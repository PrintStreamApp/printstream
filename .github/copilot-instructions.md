# PrintStream Workspace Instructions

## Architecture

- This is a Node.js + TypeScript monorepo with workspaces: `apps/api`, `apps/web`, `apps/bridge`, `apps/slicer`, and `packages/shared`.
- `apps/api` is an Express server that owns persistent MQTT connections to Bambu printers, normalizes their state, and fans out updates over a single WebSocket endpoint at `/ws`. It also handles SSDP printer auto-discovery, print dispatch (queued FTPS upload + MQTT start), camera relay, and printer SD storage browsing.
- `apps/bridge` is the runtime that runs next to the printers and owns LAN access, including **library file storage**. **Library files are bridge-owned by default** (local files are an unsupported fallback), so the bridge — not the API — normally parses 3MFs for the web, via the `library.inspect3mf` RPC. Its parser `apps/bridge/src/library-3mf.ts` is a hand-kept **mirror** of `apps/api/src/lib/three-mf.ts`; changes to the 3MF index shape must be made in both (see `bridge.instructions.md`). The bridge deploys separately from the API.
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

## Code Style

- TypeScript everywhere; keep strict mode intact.
- Keep modules focused and small. If a route mixes transport, validation, and business rules, split it.
- ASCII unless the file already needs Unicode.

## Documentation

- Non-trivial modules carry a short JSDoc header that names what they own and any non-obvious invariants.
- Exported symbols whose behavior is not obvious from the name and signature deserve a brief JSDoc.
- It is encouraged to improve docstrings on existing modules you touch even when not explicitly asked to.
- UI conventions are documented in `docs/ui-conventions.md`; backend conventions are documented in `docs/backend-conventions.md`; auth architecture is documented in `docs/auth-architecture.md`; data/event delivery is documented in `docs/data-event-contract.md`; printer driver migration guidance is documented in `docs/printer-driver-migration-plan.md`. Keep the docs and the matching instruction files aligned when those contracts change.
- These docs are mirrored into `.github/instructions/*.instructions.md` files with targeted `applyTo` patterns so Copilot loads them automatically for related edits.

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
