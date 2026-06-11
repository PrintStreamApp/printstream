# apps/api/src/plugins — domain guides

- Built-in API plugin contract → `.claude/guides/plugins.md`.
- Plugins broadcast and subscribe to events, so they are bound by the delivery contract → `.claude/guides/data-event-contract.md` (always pass a `tenantId` to `ws.broadcast()`).
- `auth-*/` provider plugins → `.claude/guides/auth-architecture.md`.
