---
applyTo: "apps/api/src/plugins/**,apps/web/src/plugins/**,apps/api/src/plugin/**,apps/web/src/plugin/**"
description: "Use when working on the plugin host or any built-in plugin."
---

# Plugin Instructions

The plugin system is the spine of the project. Treat it as a first-class API.

## When to add a plugin instead of core code

Add a plugin when the feature:

- Is optional for a meaningful subset of users (notifications, 3D preview, third-party integrations).
- Pulls in a heavy dependency that core does not otherwise need.
- Talks to an external service (HTTP webhook, third-party SDK, etc.).
- Is an obvious extension surface that third parties will want to ship variants of.

Add it to core when the feature is required for the basic product loop (printer connectivity, status, library, jobs, settings shell, transport).

## API plugin rules

- Implement `ApiPlugin` from `apps/api/src/plugin/types.ts`.
- Mount HTTP routes on the supplied `context.router`. Do not touch the top-level Express app.
- Persist plugin state through `context.settings` (key/value scoped per plugin) unless a real schema is justified.
- For per-tenant configuration (webhook URLs, push subscriptions, feature flags), use `context.settings.forTenant(tenantId)` so each tenant has isolated state.
- Subscribe to printer events through `context.printerEvents` and always pair the subscription with `context.onShutdown` so hot reloads and restarts stay clean.
- Always pass a `tenantId` to `context.ws.broadcast()`. Resolve it via `printerManager.getTenantId(printerId)` for printer-related events. Pass `null` only for deliberate platform-wide messages.
- Plugin `register()` runs at activation time, outside any per-tenant request context. Use `rootPrisma` for startup data loads, not `context.prisma`.
- Use `context.registerPrintGuard()` to gate prints with a reason (see `plate-clearing` plugin for an example).
- Auth-provider plugins must publish their bootstrap metadata through `context.registerAuthProvider()` rather than mutating the core `/api/auth` routes directly.
- Never import another plugin's modules.

## Web plugin rules

- Implement `WebPlugin` from `apps/web/src/plugin/types.ts`.
- Lazy-load route components with `React.lazy` so the main bundle is unaffected when the plugin is unused.
- Slot components must defensively read from `props` (free-form `Record<string, unknown>`) and render `null` when their prerequisites are not met.
- Never import another plugin's modules.

## Documentation

- Each plugin's `index.ts` (or `index.tsx`) must carry a JSDoc header that names the plugin's purpose, its extension surfaces, and any external dependencies.
