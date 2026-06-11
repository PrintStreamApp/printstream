---
applyTo: "apps/api/prisma/**"
description: "Use when changing the Prisma schema or migrations."
---

# Prisma Instructions

- PostgreSQL is the primary target. Prefer portable Prisma types unless a PostgreSQL-specific feature is warranted.
- Prefer migrations (`npm run db:migrate`) over `db push` once the initial schema is in place.
- Keep model and field names in `PascalCase`/`camelCase` to match the rest of the codebase.
- Plugin-scoped settings should use the existing `Setting` table via the `PluginSettingStore` rather than adding plugin-specific tables to the core schema. If a plugin truly needs its own tables, propose moving the plugin out of the core schema in a follow-up.
- Current models: `Printer`, `PrintJob`, `LibraryFile`, `LibraryFolder`, `Setting`, `Plugin`.
- After any schema change run `npm run db:generate` and update affected DTO mappers in `apps/api/src/routes/`.
