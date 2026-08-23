/**
 * CLI-free, forward-only Prisma migration applier.
 *
 * The Docker stack applies migrations with the Prisma **CLI** (see
 * `scripts/bootstrap-prisma-migrations.mjs`: `migrate deploy`, with `db push` +
 * baseline recovery for messy/pre-history databases). The native single-file
 * (SEA) self-hosted build has no CLI in the bundle, only the embedded query
 * engine and the tracked migration SQL, so it needs an applier that talks to
 * Postgres directly. This module is that applier.
 *
 * The checked-in history **replays from empty**: `00000000000000_init` is the
 * whole schema, so provisioning is not a special case, a fresh database simply
 * applies every migration in order, like any other. That leaves two branches:
 *
 * - **Fresh or existing database**: forward-apply only migrations not yet
 *   recorded. On a fresh database that is all of them, starting with init.
 * - **Schema present but no history** (a cluster restored from a dump or
 *   otherwise provisioned out-of-band): baseline-mark without running anything,
 *   so existing tables are left intact.
 *
 * Plus one transitional step, `reconcileMigrationHistory`. Databases created
 * before the squash carry rows for the 66 migrations init replaced; those rows
 * name migrations that no longer exist on disk, which would otherwise leave the
 * history permanently disagreeing with the directory (and blocks the Prisma CLI
 * outright when one of them is a FAILED row). It rewrites such a history to the
 * single init row, running no SQL: the schema those migrations produced is by
 * construction what init produces.
 *
 * Each step records a Prisma-compatible row (same table shape, same sha256
 * checksum) so the embedded database stays compatible with the Docker stack's
 * later `prisma migrate deploy`. It has **no** destructive `db push` /
 * failed-state recovery branches, it expects a clean or already-migrated
 * cluster; messy-database recovery stays a Docker-only concern.
 *
 * SQL is executed via node-postgres' simple query protocol (a single string with
 * no bind params), which runs multi-statement files and handles the dollar-quoted
 * PL/pgSQL function bodies several of our stats migrations use, both of which the
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
  /** Optional progress sink; defaults to no-op. */
  log?: (message: string) => void
}

export interface ApplyMigrationsResult {
  /** Migration names now recorded as applied by this call, in order. */
  applied: string[]
  /** Migration names already recorded before this call. */
  alreadyApplied: string[]
  /** True when migrations were recorded without being run (existing schema). */
  baselined: boolean
  /** Pre-squash rows discarded by `reconcileMigrationHistory` this call. */
  collapsedLegacyRows: number
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
 * name, the same lexical order Prisma applies them in. Uses
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

/**
 * Whether the app schema already exists, sniffed via a core table.
 *
 * Accepts EITHER name: `Tenant` was renamed to `Workspace` by
 * `20260801130000_rename_to_workspace_and_customer`, and this runs before that
 * migration on exactly the databases that still carry the old one. Probing only
 * the new name would report every not-yet-renamed database as fresh and send it
 * back through baselining.
 */
async function hasAppSchema(client: Client): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT (to_regclass('public."Workspace"') IS NOT NULL
             OR to_regclass('public."Tenant"') IS NOT NULL) AS present`
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
 * Baseline-marks every checked-in migration as applied without running any of
 * it, in one transaction. For a database whose schema was provisioned outside
 * Prisma (restored dump, `db push`), where replaying would fail on objects that
 * already exist.
 */
async function baselineExistingSchema(client: Client, all: MigrationFile[]): Promise<void> {
  await client.query('BEGIN')
  try {
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
 * Collapses a pre-squash migration history onto the init migration.
 *
 * Runs no schema SQL, and only when the history is unambiguously from before
 * the squash: it names migrations that are not on disk, and the app schema is
 * present. Those rows recorded exactly the schema `00000000000000_init` now
 * contains, so the history is rewritten rather than replayed.
 *
 * Deliberately reads rows regardless of `finished_at`, so a FAILED row for a
 * retired migration is cleared too, a failed row blocks `prisma migrate deploy`
 * permanently (P3009), and leaving one behind would strand the Docker stack on
 * a database this applier had otherwise brought up to date.
 *
 * Returns the number of stale rows discarded (0 when there was nothing to do).
 */
export async function reconcileMigrationHistory(
  client: Client,
  all: MigrationFile[],
  log: (message: string) => void = () => undefined
): Promise<number> {
  const init = all[0]
  if (!init) return 0

  const existing = await client.query<{ migration_name: string }>(
    `SELECT "migration_name" FROM "_prisma_migrations"`
  )
  if (existing.rows.length === 0) return 0

  const onDisk = new Set(all.map((migration) => migration.name))
  const stale = existing.rows.map((row) => row.migration_name).filter((name) => !onDisk.has(name))
  if (stale.length === 0) return 0

  // Only a database that already carries the schema can be collapsed; anything
  // else is a history we do not recognise, and guessing would be destructive.
  if (!(await hasAppSchema(client))) return 0

  const alreadyRecorded = (await readAppliedMigrationNames(client)).has(init.name)
  await client.query('BEGIN')
  try {
    await client.query(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = ANY($1::text[])`, [stale])
    if (!alreadyRecorded) await recordMigration(client, init)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to collapse pre-squash migration history: ${reason}`)
  }

  log(`Collapsed ${stale.length} pre-squash migration row(s) onto ${init.name}.`)
  return stale.length
}

/**
 * Brings the database at `databaseUrl` up to the checked-in schema by
 * forward-applying migrations it has not recorded, on a fresh database that is
 * the whole history, starting with init. A schema present without any history is
 * baseline-marked instead of replayed. Idempotent: a second call with no new
 * migrations is a no-op. Throws on the first failing migration (its transaction
 * rolls back; earlier ones stay applied).
 */
export async function applyPendingMigrations(options: ApplyMigrationsOptions): Promise<ApplyMigrationsResult> {
  const { databaseUrl, migrationsDir = defaultMigrationsDir() } = options
  const log = options.log ?? (() => undefined)

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await client.query(PRISMA_MIGRATIONS_DDL)
    const all = listMigrationFiles(migrationsDir)
    const collapsedLegacyRows = await reconcileMigrationHistory(client, all, log)
    const appliedNames = await readAppliedMigrationNames(client)

    // Schema but no history: restored from a dump, or provisioned with
    // `db push`. Replaying init would fail on tables that already exist, so
    // record the history instead of running it.
    if (appliedNames.size === 0 && await hasAppSchema(client)) {
      log('Existing schema without Prisma history; baselining checked-in migrations.')
      await baselineExistingSchema(client, all)
      return {
        applied: all.map((migration) => migration.name),
        alreadyApplied: [],
        baselined: true,
        collapsedLegacyRows
      }
    }

    const pending = selectPendingMigrations(all, appliedNames)
    if (pending.length === 0) {
      log('Database is up to date; no migrations to apply.')
      return { applied: [], alreadyApplied: [...appliedNames], baselined: false, collapsedLegacyRows }
    }

    log(`Applying ${pending.length} migration(s)...`)
    const applied: string[] = []
    for (const migration of pending) {
      await applyOne(client, migration)
      applied.push(migration.name)
      log(`Applied ${migration.name}`)
    }
    return { applied, alreadyApplied: [...appliedNames], baselined: false, collapsedLegacyRows }
  } finally {
    await client.end().catch(() => undefined)
  }
}
