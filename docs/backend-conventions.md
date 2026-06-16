# Backend Conventions

These conventions describe the backend patterns the API already relies on and the places where we want consistency to be explicit.

## Contracts and validation

- Define cross-app request and response contracts in `packages/shared` with Zod.
- Keep API-only schemas local to the owning route or module.
- Validate external input at the route boundary before it reaches printer, Prisma, or plugin logic.

## Route shape

- Keep route handlers thin. Move reusable transport, persistence, and business rules into `apps/api/src/lib`.
- Use shared request helpers such as `requireRouteParam` and `requireRequestTenantId` from `apps/api/src/lib/request-helpers.ts` instead of re-declaring small parsing helpers in each route or plugin.
- Prefer route modules that orchestrate domain helpers over routes that compute, mutate, and serialize everything inline.
- Large browser uploads should use chunked upload sessions with raw binary chunk requests below common reverse-proxy body-size caps, then finalize through the same persistence path as direct uploads. If finalization performs additional long-running server-side transfer work, expose session status so the web UI can show that phase separately from the browser upload.

## Errors and request failures

- Throw `HttpError` helpers (`badRequest`, `notFound`, `conflict`, and related helpers) instead of building error responses inline.
- Do not throw raw `Error` for user-input or route-validation failures.
- Keep error messages user-safe: informative enough for the caller, but never leaking secrets such as LAN access codes.
- Keep API abuse controls in middleware, not in individual route handlers. A coarse API bucket should run before body parsing/auth work, actor-aware read/write buckets should run before route handlers, and expensive new route families should either reuse an existing bucket or add a narrowly scoped one.
- Return standard `429` responses with `Retry-After` for rate-limited clients, and advertise the remaining budget on every limited route via `RateLimit-Limit`/`RateLimit-Remaining`/`RateLimit-Reset` headers (most-restrictive limiter wins when limiters stack) so bursty clients such as chunked library uploads can pace themselves proactively. Do not log request bodies, auth codes, tokens, LAN access codes, or other secrets while handling throttled traffic.

## Logging and audit trail

- `console.*` is the operational logger — it is captured into the in-memory buffer surfaced at `/api/logs` (plugins use the scoped `context.logger`). Make failures observable: log error/failure paths at `console.warn`/`console.error` rather than silently swallowing them. An empty `catch {}` or a `.catch(() => …)` that drops a real error is a coverage gap, not a style choice — keep a swallow only when it is genuinely benign (and say why in a short comment).
- Use the right level — failures at `warn`/`error`, routine activity at `log`/`info` — and avoid per-iteration logging in hot loops (camera frames, MQTT/status reports).
- Record user-visible mutations in the durable audit trail. Every POST/PUT/PATCH/DELETE already gets a baseline `AuditLog` row; mutating or privileged handlers should enrich it via `annotateRequestAuditLog` with a specific action, resource, human-readable summary, and the resource id in metadata (see `auth-management.ts` / `library.ts` for the pattern).
- Never log — or place in audit metadata — any secret: LAN/printer access codes, session/runtime/API tokens, OAuth `clientSecret`, bridge connect codes, auth/email codes, webhook/topic URLs, or raw request bodies. Log only error messages and safe identifiers (printerId, file/job id, booleans such as `clientSecretConfigured`).

## Tenant isolation

- Treat `tenantId` as part of the record identity for tenant-owned resources.
- Do not assume external identifiers such as printer serials are globally unique across tenants.
- Use cross-tenant access deliberately. Reach for `rootPrisma` only when the operation is intentionally platform-wide.
- Every Prisma model with a `tenantId` column must appear in the `TENANT_SCOPED_MODELS` set in `src/lib/prisma.ts`. When adding a new model, update the set.
- Durable stats must follow the same tenant-identity rule: tenant stats are tenant-scoped, printer stats are keyed by tenant plus printer serial, and platform rollups use `rootPrisma` only for deliberate all-tenant reads.
- Nested `connect` / `include` relations are not tenant-scoped by the Prisma extension. Routes that accept user-supplied relation IDs must validate ownership at the application layer.
- Plugin startup code runs outside any tenant request context. Use `rootPrisma` for initial data loads and resolve tenant ownership from `printerManager.getTenantId()` for event-driven broadcasts.

## WebSocket broadcasts

- Always pass an explicit `tenantId` to `ws.broadcast()`. Use `null` deliberately for platform-wide events; never omit the argument.
- In plugins, resolve the printer's tenant via `printerManager.getTenantId(printerId)` before broadcasting.

## Shared infrastructure

- Read env only through `src/lib/env.ts`.
- Use the Prisma singleton from `src/lib/prisma.ts`.
- Keep high-level stats efficient and durable. Prefer persisted rollups or targeted aggregates over request-time scans of print history; record filament usage at job end when the selected source can be resolved.
- Add new WS event shapes to `packages/shared` first, then broadcast them from `src/lib/ws-server.ts` or the resource-event helpers.
- Use `printerEvents`, `print-dispatcher`, `print-guards`, and `notification-format` instead of re-implementing those behaviors at call sites.

## Plugins

- Plugins depend on plugin context, not on another plugin's internals.
- Any plugin subscription or external connection must register shutdown cleanup.
- Heavy or optional behavior belongs in plugins rather than in core routes.

## Tests

- Add focused regression coverage for long-lived behavior such as tenant isolation, cleanup, caching, streaming, discovery, and other stateful flows.
- When changing a shared contract or event, update the corresponding backend and frontend consumers together.