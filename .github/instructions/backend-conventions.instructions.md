---
applyTo: "apps/api/**,packages/shared/src/**"
description: "Automatically load the repo's backend conventions when working in API or shared contract code."
---

# Backend Convention Instructions

- Treat `docs/backend-conventions.md` as the human-readable source of truth for the rules below and keep this file aligned with it.
- Define cross-app request and response contracts in `packages/shared/src` with Zod. Keep API-only schemas local to the owning route or module.
- Validate external input at the route boundary before it reaches printer, Prisma, or plugin logic.
- Keep route handlers thin. Move reusable transport, persistence, and business rules into `apps/api/src/lib`.
- Reuse `requireRouteParam` and `requireRequestTenantId` from `apps/api/src/lib/request-helpers.ts` instead of redefining small route parsing helpers.
- Large browser uploads should use chunked upload sessions with raw binary chunk requests below common reverse-proxy body-size caps, then finalize through the same persistence path as direct uploads. If finalization performs additional long-running server-side transfer work, expose session status so the web UI can show that phase separately from the browser upload.
- Throw `HttpError` helpers for request validation and user-input failures. Do not throw raw `Error` when a client should receive a structured HTTP response.
- Keep API abuse controls in middleware, not individual route handlers. A coarse API bucket should run before body parsing/auth work, actor-aware read/write buckets should run before route handlers, and expensive new route families should either reuse an existing bucket or add a narrowly scoped one.
- Return standard `429` responses with `Retry-After` for rate-limited clients. Never log request bodies, auth codes, tokens, LAN access codes, or other secrets while handling throttled traffic.
- Treat `tenantId` as part of the identity for tenant-owned data. Do not assume printer serials or other external identifiers are globally unique across tenants.
- Default to the shared `prisma` client and tenant-scoped queries. Reach for `rootPrisma` only when the operation is intentionally platform-wide.
- Every Prisma model with a `tenantId` column must appear in `TENANT_SCOPED_MODELS` in `apps/api/src/lib/prisma.ts`. Nested `connect`/`include` relations are not tenant-scoped automatically; validate relation ownership at the application layer when accepting user-supplied IDs.
- Durable stats must follow the same tenant-identity rule: tenant stats are tenant-scoped, printer stats are keyed by tenant plus printer serial, and platform rollups use `rootPrisma` only for deliberate all-tenant reads.
- Always pass an explicit `tenantId` to `ws.broadcast()`. Use `null` deliberately for platform-wide events; never omit the argument. In plugins, resolve the tenant via `printerManager.getTenantId(printerId)`.
- Plugin startup code runs outside any tenant request context. Use `rootPrisma` for initial data loads and resolve tenant ownership from `printerManager.getTenantId()` for event-driven broadcasts.
- For per-tenant plugin configuration (webhook URLs, push subscriptions), use `context.settings.forTenant(tenantId)` rather than the base `context.settings` store.
- Add new WS event shapes to `packages/shared` before broadcasting them from the API.
- Keep high-level stats efficient and durable. Prefer persisted rollups or targeted aggregates over request-time scans of print history; record filament usage at job end when the selected source can be resolved.
- Reuse shared infrastructure such as `printerEvents`, `print-dispatcher`, `print-guards`, and `notification-format` instead of re-implementing those behaviors at call sites.
- Add focused regression coverage for tenant isolation, cleanup, caching, streaming, discovery, and other long-lived stateful behavior.