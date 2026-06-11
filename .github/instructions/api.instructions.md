---
applyTo: "apps/api/**"
description: "Use when working in the Express API, route modules, MQTT/WS code, plugin host, or persistence."
---

# API Instructions

- Validate external input at the boundary using shared Zod schemas from `@printstream/shared`, or local Zod schemas when the contract is API-only.
- Keep route handlers thin. Put reusable logic in modules under `src/lib`.
- Throw `HttpError` (or the `badRequest`/`notFound`/`conflict` helpers) instead of building error responses inline.
- Never read `process.env` outside `src/lib/env.ts`.
- Changes to caching, cleanup, retention, streaming, or other long-lived server behavior should ship with focused regression tests so memory/disk safeguards stay covered.
- Printer-domain code emits/consumes events on the `printerEvents` bus. The MQTT manager is the only producer of `status`, `job.started`, and `job.finished`.
- WS broadcast lives in `src/lib/ws-server.ts`. Add new event types to `@printstream/shared` first so the web client knows how to parse them.
- Print dispatch (upload + start) is handled by `src/lib/print-dispatcher.ts`. It serializes FTPS uploads per-printer and supports cancellation. Do not bypass it.
- Print guards (`src/lib/print-guards.ts`) let plugins gate prints. Plugins register guards via `context.registerPrintGuard()`.
- The API keeps the bridge-fed discovery cache in `src/lib/printer-discovery.ts`; bridge runtimes own the actual LAN SSDP listener and forward snapshots over bridge sessions.
- Shared request helpers belong in `src/lib/request-helpers.ts`. Reuse `requireRouteParam` / `requireRequestTenantId` instead of redefining small param or tenant extractors in each route or plugin.
- Treat `tenantId` as part of the identity for tenant-owned data. Do not assume printer serials or other external ids are globally unique across tenants.
- Keep cross-app contracts in `packages/shared`; keep API-only schemas local to the owning module.
- Do not throw raw `Error` for request validation or user-input failures. Use `HttpError` helpers so responses stay consistent.
- Use `rootPrisma` only for deliberate platform-wide operations; default to the shared `prisma` client and tenant-scoped queries.

## Plugin host

- Built-in API plugins live under `src/plugins/<name>/` and are registered in `src/plugin/builtin.ts`.
- Plugins receive a scoped `router`, `settings` store, `logger`, the printer event bus, the WS broadcaster, the Prisma client, and a `registerPrintGuard()` hook. Use those instead of importing module internals.
- Always register a shutdown handler (`context.onShutdown(...)`) for any subscription or external connection a plugin opens.
- Never import one plugin from another.
- Third-party plugins can be uploaded via `/api/admin/plugins` and are installed into `PLUGINS_DIR`.

## Shared helpers

- Auth/authorization is core platform behavior. Request auth comes from `src/lib/auth-context.ts`; browser sessions live in `src/lib/auth-session.ts`; route permission gates should use `requireRequestPermission()` / `assertRequestPermission()` from `src/lib/authorization.ts` instead of inlining checks.
- Public auth-provider metadata is exposed through `/api/auth/bootstrap`. Provider plugins should register descriptors through `context.registerAuthProvider(...)` instead of patching bootstrap routes directly.
- Prisma access goes through the singleton in `src/lib/prisma.ts`.
- Notification formatting is centralized in `src/lib/notification-format.ts`. Adding a new trigger means adding a branch there; every channel picks it up automatically.
- Module headers (short JSDoc) are expected on every file in `src/lib`, `src/routes`, and `src/plugin`.

## 3MF parsing is duplicated (read before editing `three-mf.ts`)

Library files are **bridge-owned by default** (local, non-bridge files are an unsupported fallback). So the 3MF index the web normally sees is produced on the bridge by `apps/bridge/src/library-3mf.ts` via the `library.inspect3mf` RPC — a hand-kept **mirror** of `apps/api/src/lib/three-mf.ts`. `three-mf.ts` only runs for the local-copy/fallback parse and for slice-time 3MF rewriting.

When you change the parsed 3MF **index shape** (e.g. add a per-plate field like `objects`):
1. Apply the change in **both** `apps/api/src/lib/three-mf.ts` and `apps/bridge/src/library-3mf.ts`.
2. Add the field to the shared schema (`bridgeLibraryThreeMfIndexSchema` / `threeMfPlateSchema`) — Zod strips anything the schema omits, silently dropping new fields.
3. Bump **both** `THREE_MF_PARSER_CACHE_VERSION` constants and `BRIDGE_LIBRARY_DERIVED_CACHE_VERSION` in `bridge-library-files.ts`, or stale cached indexes will be served.
