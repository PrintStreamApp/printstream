/**
 * CLI-free, forward-only Prisma migration applier.
 *
 * The Docker stack applies migrations with the Prisma **CLI** (see
 * `scripts/bootstrap-prisma-migrations.mjs`: `migrate deploy`, with `db push` +
 * baseline recovery for messy/pre-history databases). The native single-file
 * (SEA) self-hosted build has no CLI in the bundle — only the embedded query
 * engine and the tracked migration SQL — so it needs an applier that talks to
 * Postgres directly. This module is that applier.
 *
 * The checked-in migration history is **not replayable from empty** — the
 * earliest migration assumes pre-history auth tables (`AuthGroup`, ...) that no
 * migration creates, exactly the baseline gap the Docker CLI bootstrap recovers
 * from with `db push` + baseline. So a fresh database cannot be provisioned by
 * replaying migrations; it must materialize `schema.prisma` wholesale. The
 * CLI-free equivalent is Prisma's standard **baseline** workflow:
 *
 * - **Fresh database** (no `_prisma_migrations` history, no app schema): run the
 *   checked-in full-schema snapshot `prisma/baseline.sql` (generated from
 *   `schema.prisma` via `npm run prisma:baseline` — regenerate it whenever the
 *   schema/migrations change; it must equal the cumulative migration history),
 *   then mark every checked-in migration as applied (baseline). Nothing replays.
 * - **Existing database** (has history): forward-apply only migrations not yet
 *   recorded — the upgrade path, where a newly-added migration is a clean delta.
 * - **Schema present but no history** (a BYO database provisioned out-of-band):
 *   baseline-mark without re-running the snapshot, so existing tables are left
 *   intact.
 *
 * Each step records a Prisma-compatible row (same table shape, same sha256
 * checksum) so a bring-your-own-Postgres database stays compatible with later
 * `prisma migrate deploy`. It has **no** destructive `db push` / failed-state
 * recovery branches: the BYO escape hatch is documented as "point at a clean or
 * already-migrated database"; messy-database recovery stays a Docker-only concern.
 *
 * SQL is executed via node-postgres' simple query protocol (a single string with
 * no bind params), which runs multi-statement files and handles the dollar-quoted
 * PL/pgSQL function bodies several of our stats migrations use — both of which the
 * Prisma client's extended-protocol `$executeRaw` cannot do.
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * Tracked migrations live at `apps/api/prisma/migrations`. This module sits at
 * `apps/api/src/lib` (tsx) or `apps/api/dist/lib` (compiled); both resolve to
 * `apps/api` two levels up.
 */
export function defaultMigrationsDir(): string {
  // The packaged (SEA) build has no source tree on disk; it extracts the
  // migration SQL as an asset and points here via this env override.
  return process.env.PRINTSTREAM_MIGRATIONS_DIR ?? path.resolve(moduleDir, '..', '..', 'prisma', 'migrations')
}

/** Full-schema snapshot used to provision a fresh database (`prisma/baseline.sql`). */
export function defaultBaselineSqlPath(): string {
  return process.env.PRINTSTREAM_BASELINE_SQL ?? path.resolve(moduleDir, '..', '..', 'prisma', 'baseline.sql')
}

/** A single checked-in migration: its directory name, SQL body, and checksum. */
export interface MigrationFile {
  /** Directory name, e.g. `20260505150000_platform_groups`. */
  name: string
  /** Contents of the migration's `migration.sql`. */
  sql: string
  /** Lowercase hex sha256 of the raw `migration.sql` bytes (matches Prisma). */
  checksum: string
}

export interface ApplyMigrationsOptions {
  /** Postgres connection string for the target cluster. */
  databaseUrl: string
  /** Directory of checked-in migrations. Defaults to `defaultMigrationsDir()`. */
  migrationsDir?: string
  /** Full-schema snapshot for fresh databases. Defaults to `defaultBaselineSqlPath()`. */
  baselineSqlPath?: string
  /** Optional progress sink; defaults to no-op. */
  log?: (message: string) => void
}

export interface ApplyMigrationsResult {
  /** Migration names now recorded as applied by this call, in order. */
  applied: string[]
  /** Migration names already recorded before this call. */
  alreadyApplied: string[]
  /** True when the full-schema baseline snapshot was materialized this call. */
  baselined: boolean
}

/** Prisma's exact `_prisma_migrations` table shape, so the CLI stays compatible. */
const PRISMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" VARCHAR(36) NOT NULL,
  "checksum" VARCHAR(64) NOT NULL,
  "finished_at" TIMESTAMPTZ,
  "migration_name" VARCHAR(255) NOT NULL,
  "logs" TEXT,
  "rolled_back_at" TIMESTAMPTZ,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "_prisma_migrations_pkey" PRIMARY KEY ("id")
)`

/** The sha256 hex digest Prisma records as a migration's checksum. */
export function migrationChecksum(sql: Buffer | string): string {
  return createHash('sha256').update(sql).digest('hex')
}

/**
 * Reads every migration directory (those containing a `migration.sql`) sorted by
 * name — the same lexical order Prisma applies them in. Uses
 * `listCheckedInMigrationNames`-style sorting so the two appliers can't diverge.
 */
export function listMigrationFiles(migrationsDir = defaultMigrationsDir()): MigrationFile[] {
  const entries = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))

  const migrations: MigrationFile[] = []
  for (const name of entries) {
    const sqlPath = path.join(migrationsDir, name, 'migration.sql')
    let raw: Buffer
    try {
      raw = readFileSync(sqlPath)
    } catch {
      // A directory without a migration.sql is not a Prisma migration; skip it.
      continue
    }
    migrations.push({ name, sql: raw.toString('utf8'), checksum: migrationChecksum(raw) })
  }
  return migrations
}

/** Migrations not present in `appliedNames`, preserving `all`'s order. */
export function selectPendingMigrations(all: MigrationFile[], appliedNames: ReadonlySet<string>): MigrationFile[] {
  return all.filter((migration) => !appliedNames.has(migration.name))
}

async function readAppliedMigrationNames(client: Client): Promise<Set<string>> {
  const result = await client.query<{ migration_name: string }>(
    `SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`
  )
  return new Set(result.rows.map((row) => row.migration_name))
}

/** Whether the app schema already exists, sniffed via a core table. */
async function hasAppSchema(client: Client): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass('public."Tenant"') IS NOT NULL AS present`
  )
  return result.rows[0]?.present === true
}

/** Records a migration as applied. Caller owns the surrounding transaction. */
async function recordMigration(client: Client, migration: MigrationFile): Promise<void> {
  await client.query(
    `INSERT INTO "_prisma_migrations"
       ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
     VALUES ($1, $2, now(), $3, NULL, NULL, now(), 1)`,
    [randomUUID(), migration.checksum, migration.name]
  )
}

async function applyOne(client: Client, migration: MigrationFile): Promise<void> {
  await client.query('BEGIN')
  try {
    // Simple query protocol: runs every statement in the file and tolerates the
    // dollar-quoted function bodies our stats migrations contain.
    await client.query(migration.sql)
    await recordMigration(client, migration)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to apply migration ${migration.name}: ${reason}`)
  }
}

/**
 * Provisions a fresh database from the baseline snapshot (when `materialize`),
 * then baseline-marks every checked-in migration as applied — all in one
 * transaction so a failure leaves the database untouched.
 */
async function baselineFromSnapshot(
  client: Client,
  all: MigrationFile[],
  baselineSqlPath: string,
  materialize: boolean
): Promise<void> {
  await client.query('BEGIN')
  try {
    if (materialize) {
      const baselineSql = readFileSync(baselineSqlPath, 'utf8')
      await client.query(baselineSql)
    }
    for (const migration of all) {
      await recordMigration(client, migration)
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to baseline database: ${reason}`)
  }
}

/**
 * Brings the database at `databaseUrl` up to the checked-in schema. Fresh
 * databases are provisioned from `baseline.sql` and baselined; existing
 * databases forward-apply only migrations they have not yet recorded. Idempotent:
 * a second call with no new migrations is a no-op. Throws on the first failing
 * migration (its transaction rolls back; earlier ones stay applied).
 */
export async function applyPendingMigrations(options: ApplyMigrationsOptions): Promise<ApplyMigrationsResult> {
  const {
    databaseUrl,
    migrationsDir = defaultMigrationsDir(),
    baselineSqlPath = defaultBaselineSqlPath()
  } = options
  const log = options.log ?? (() => undefined)

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await client.query(PRISMA_MIGRATIONS_DDL)
    const appliedNames = await readAppliedMigrationNames(client)
    const all = listMigrationFiles(migrationsDir)

    if (appliedNames.size === 0) {
      // No Prisma history: either a truly fresh database or one provisioned
      // out-of-band. The checked-in history can't replay from empty, so a fresh
      // database is materialized from the snapshot; a pre-provisioned one is just
      // baselined so its existing tables are left intact.
      const provisioned = await hasAppSchema(client)
      log(
        provisioned
          ? 'Existing schema without Prisma history; baselining checked-in migrations.'
          : `Fresh database; materializing schema and baselining ${all.length} migration(s).`
      )
      await baselineFromSnapshot(client, all, baselineSqlPath, !provisioned)
      return { applied: all.map((migration) => migration.name), alreadyApplied: [], baselined: !provisioned }
    }

    const pending = selectPendingMigrations(all, appliedNames)
    if (pending.length === 0) {
      log('Database is up to date; no migrations to apply.')
      return { applied: [], alreadyApplied: [...appliedNames], baselined: false }
    }

    log(`Applying ${pending.length} migration(s)...`)
    const applied: string[] = []
    for (const migration of pending) {
      await applyOne(client, migration)
      applied.push(migration.name)
      log(`Applied ${migration.name}`)
    }
    return { applied, alreadyApplied: [...appliedNames], baselined: false }
  } finally {
    await client.end().catch(() => undefined)
  }
}
