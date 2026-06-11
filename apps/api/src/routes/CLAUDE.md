# apps/api/src/routes — domain guides

- Every route here participates in workspace-scoped delivery → read `.claude/guides/data-event-contract.md` (tenant hints, broadcast scoping, `auth.changed`).
- General route shape (thin handlers, Zod at the boundary, `HttpError`, tenant scoping) → `.claude/guides/backend-conventions.md`.
- `auth*.ts` → `.claude/guides/auth-architecture.md`.
- `printer*.ts` / `printers*.ts` → `.claude/guides/printer-driver-migration.md`.
