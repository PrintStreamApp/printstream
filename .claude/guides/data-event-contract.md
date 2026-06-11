# Data and event delivery contract

Read this when working on HTTP loading, WebSocket delivery, workspace context, cache invalidation, or auth-change events. It applies to: `apps/api/src/lib/ws*.ts`, `apps/api/src/lib/*event*.ts`, `apps/api/src/lib/auth-context.ts`, `apps/api/src/routes/**`, `apps/api/src/plugins/**`, `apps/web/src/hooks/usePrinterWebSocket.ts`, `apps/web/src/lib/ws*.ts`, `apps/web/src/lib/apiClient.ts`, `apps/web/src/lib/workspaceContext.ts`, `apps/web/src/lib/*QueryInvalidation.ts`, `packages/shared/src/ws-events.ts`.

Treat `docs/data-event-contract.md` as the human-readable source of truth for the rules below and keep this file aligned with it.

- A browser tab has exactly one active workspace context: either the platform workspace or one tenant workspace.
- Tenant-owned HTTP data and tenant-scoped WebSocket events must be delivered only to clients whose active workspace is that tenant.
- Platform workspace clients must not receive tenant printer status, tenant discovery, tenant jobs, tenant library, tenant orders, tenant logs, or tenant plugin-setting events.
- Tenant workspace clients must not receive another tenant's events.
- Global broadcasts are allowed only when the payload contains no tenant-owned data and every recipient has a legitimate reason to refresh global state.
- WebSocket payloads must not contain secrets, access codes, service-account tokens, or cross-workspace identifiers that the active workspace could not fetch over HTTP.
- HTTP requests send the tab-local workspace hint with `X-PrintStream-Tenant`; WebSocket connections send the same hint as the `tenant` query parameter.
- The value `platform` means platform workspace. The value `none` means the tab is intentionally outside any workspace and should not fall back to a stale cookie context. Tenant values are slugs, not tenant names.
- API tenant resolution must prefer explicit tab hints before the shared tenant-context cookie, while service-account and already-bound tenant actors cannot use hints to escape their authenticated tenant.
- WebSocket connections must authorize during upgrade using the same auth and tenant-resolution path as HTTP requests.
- `printer.status`, `printer.removed`, `printer.discovered`, `camera.snapshot.updated`, `printer.ftps.active`, tenant resource changes, and tenant plugin events are tenant-scoped unless explicitly proven global and payload-safe.
- Camera subscribe/watch requests must re-check both permission and printer tenant ownership at request time.
- Effective roles and permissions must take effect immediately. Role, login-disabled, user deletion, session revocation, and support-access changes should send `auth.changed` to affected tabs and recycle stale sockets.
- The web client treats WebSocket events as invalidation hints, not authorization proof. Sensitive data must remain protected by HTTP route guards even when stale UI briefly shows an old control.
- Add regression coverage whenever event or data delivery changes, especially for multi-tab workspace isolation, WS replay scoping, plugin-setting invalidation, and auth-change socket recycling.
