# Shared contracts (packages/shared)

`packages/shared/src` holds the Zod schemas + inferred types used by both `apps/api` and `apps/web`. It is the single source of truth for cross-app request/response and event shapes — do not duplicate those shapes in the API or web app.

- Define cross-app contracts here with Zod. Keep API-only schemas local to the owning route/module in `apps/api`.
- Add new WebSocket event shapes here **before** broadcasting them from the API or parsing them in the web client.
- Treat `tenantId` as part of the identity for tenant-owned data; do not assume printer serials or other external IDs are globally unique across tenants.

When changing contracts, also read the guide that matches the area:

- `.claude/guides/backend-conventions.md` — general contract + tenancy conventions.
- `.claude/guides/data-event-contract.md` — for `ws-events.ts` and event delivery.
- `.claude/guides/auth-architecture.md` — for `auth*.ts`, `permissions.ts`, `tenants.ts`.
- `.claude/guides/printer-driver-migration.md` — for `printer*.ts`, `print-compatibility.ts`.

## Private contracts

- `src/private/` holds closed-source cloud contracts, exported as `@printstream/shared/private`. Public-surface modules must never import from it; the public export deletes the directory (see `docs/open-core.md`).
