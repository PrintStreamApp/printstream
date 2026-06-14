# Data And Event Delivery Contract

This document is the design contract for HTTP data loading, WebSocket events, and cache invalidation in PrintStream. Security boundaries matter more than convenience: update this document first when the intended model changes, then add tests that prove the implementation follows it.

## Core rules

- A browser tab has exactly one active workspace context: either the platform workspace or one tenant workspace.
- Tenant-owned data and tenant-scoped events must be delivered only to clients whose active workspace is that tenant.
- Platform workspace clients must not receive tenant printer status, tenant discovery, tenant job, tenant library, tenant order, tenant log, or tenant plugin-setting events.
- Tenant workspace clients must not receive another tenant's events.
- Global events are allowed only when the payload contains no tenant-owned data and every recipient has a legitimate reason to refresh global state. Plugin installation or tenant availability changes are examples; printer status is not.
- A WebSocket payload must not contain secrets, access codes, service-account tokens, or cross-workspace identifiers that the active workspace could not fetch over HTTP.

## Workspace context

The active workspace is tab-local. Cookies may be used as a compatibility fallback, but they are not the source of truth for a browser tab because multiple tabs can view different workspaces at the same time.

- HTTP requests send the tab-local workspace hint with `X-PrintStream-Tenant`.
- WebSocket connections send the same hint as the `tenant` query parameter because browser WebSocket clients cannot set custom headers.
- The value `platform` means platform workspace.
- The value `none` means the tab is intentionally outside any platform or tenant workspace, such as on the workspace chooser or auth surface. It clears any stale cookie-derived tenant context for that request.
- Tenant values are tenant slugs, not tenant names.
- The API resolves explicit tab hints before the shared tenant-context cookie.
- Service-account and already-bound tenant actors cannot use a browser hint to escape their authenticated tenant.

## WebSocket delivery

WebSocket connections are authorized during upgrade using the same auth and tenant-resolution path as HTTP requests. The server stores the resolved tenant and auth context with each socket.

- `printer.status`, `printer.removed`, `printer.discovered`, `camera.snapshot.updated`, and `printer.ftps.active` are tenant-scoped.
- `resource.changed` is tenant-scoped unless the changed resource is truly global.
- `plugin.event` must be tenant-scoped unless the plugin event is truly global and contains no tenant-owned data.
- Camera subscribe/watch requests must re-check both permission and printer tenant ownership at request time.
- Long-lived sockets must be recycled when effective auth changes so stale permission snapshots cannot continue receiving events.

## Auth changes

Effective roles and permissions must take effect immediately.

- HTTP requests resolve permissions from the database on each request.
- When role assignments, role permissions, login-disabled state, user deletion, session revocation, or support-access policy changes, affected browser tabs receive `auth.changed` and their WebSocket is closed so reconnect re-runs auth and tenant resolution.
- Tenant role changes should target affected users in that tenant.
- Platform role changes should target affected platform users across all open workspace contexts, because bypass/support permissions can affect tenant entry.
- Support-access changes should invalidate sockets in that tenant workspace.

## Client cache behavior

The web client treats WebSocket events as invalidation hints, not authorization proof.

- On `auth.changed`, the client refetches `/api/auth/bootstrap`, plugin catalog, general settings, and drops live printer/discovery caches.
- Route and action visibility must derive from the refreshed bootstrap permissions.
- Components must not keep polling to compensate for missed events; event correctness belongs in the WS contract.
- Sensitive data must remain protected by HTTP route guards even if a stale client UI still shows an old control briefly.

## Regression strategy

Add or update tests whenever event or data delivery changes:

- Two tabs can hold different active workspaces without one tab's HTTP or WS context changing the other.
- Tenant WS replay includes only that tenant's printer statuses and discovered printers.
- Platform WS replay includes no tenant printer statuses.
- Tenant plugin setting changes invalidate only that tenant's clients.
- Role or permission changes send `auth.changed` to affected users and recycle stale sockets.
- Platform role changes affect platform users even when they currently have tenant tabs open.
- Global broadcasts are reviewed for payload safety before being sent to all clients.
