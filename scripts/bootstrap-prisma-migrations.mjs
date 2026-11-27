/**
 * Startup bootstrap: applies checked-in Prisma migrations before the
 * API server starts.
 *
 * For databases that cannot consume the checked-in migration history as-is
 * (for example a pre-history database that triggers P3005, or a fresh
 * database where the earliest checked-in migration assumes older auth
 * tables already exist), we fall back to `db push` and then baseline the
 * checked-in migrations as applied so future deploys can return to
 * `migrate deploy`.
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'
import pg from 'pg'
import {
  getPrismaOutput,
  hasFailedMigrationState,
  isNonEmptyDatabaseBaselineCase,
  isPreSquashMigrationName,
  isRecoverableFreshInstallBaselineGap,
  isAlreadyExistsError,
  isMountPoint,
  lastCreatedObject,
  replayableMigrationSql,
  isRollbackDamagedHistory,
  listCheckedInMigrationNames
} from './lib/bootstrap-prisma-migrations.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const prismaBinary = path.join(repoRoot, 'node_modules', '.bin', 'prisma')
const schemaPath = path.join(repoRoot, 'apps', 'api', 'prisma', 'schema.prisma')
const migrationsDir = path.join(repoRoot, 'apps', 'api', 'prisma', 'migrations')

function runPrisma(commandArgs, { tolerateFailure = false } = {}) {
  const result = spawnSync(prismaBinary, commandArgs, {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8'
  })

  if (!tolerateFailure) {
    writePrismaOutput(result)
  }

  if ((result.status ?? 1) !== 0 && !tolerateFailure) {
    const output = getPrismaOutput(result)
    const error = new Error(output || `Prisma command failed: ${commandArgs.join(' ')}`)
    throw error
  }

  return result
}

function writePrismaOutput(result) {
  if (result.stdout) {
    process.stdout.write(result.stdout)
  }

  if (result.stderr) {
    process.stderr.write(result.stderr)
  }
}

async function withPrisma(run) {
  const prisma = new PrismaClient()
  try {
    return await run(prisma)
  } finally {
    await prisma.$disconnect().catch(() => undefined)
  }
}

async function hasOnlyMigrationHistoryTable() {
  return await withPrisma(async (prisma) => {
    const rows = await prisma.$queryRawUnsafe(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    )
    const tableNames = rows.map((row) => row.tablename)
    return tableNames.length === 1 && tableNames[0] === '_prisma_migrations'
  })
}

async function resetFailedMigrationHistory() {
  await withPrisma(async (prisma) => {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "_prisma_migrations"')
  })
}

function baselineCheckedInMigrations() {
  for (const migrationName of listCheckedInMigrationNames(migrationsDir)) {
    runPrisma(['migrate', 'resolve', '--applied', migrationName, '--schema', schemaPath])
  }
}

async function synchronizeSchemaWithBaseline(message) {
  process.stdout.write(message)
  runPrisma(['db', 'push', '--schema', schemaPath, '--skip-generate'])
  baselineCheckedInMigrations()
  process.stdout.write('Database schema synchronized with prisma db push and checked-in migrations baselined.\n')
}

/**
 * Collapses a pre-squash migration history onto `00000000000000_init`.
 *
 * Mirrors `reconcileMigrationHistory` in `apps/api/src/lib/apply-migrations.ts`:
 * the native (SEA) build has no Prisma CLI and runs that one; the Docker/dev
 * stack runs this. Must happen BEFORE `migrate deploy`, because a leftover row
 * for a retired migration makes the CLI refuse to do anything (P3009) rather
 * than report something this script could recover from.
 */
async function collapsePreSquashMigrationHistory() {
  const onDisk = new Set(listCheckedInMigrationNames(migrationsDir))
  const [init] = [...onDisk].sort((left, right) => left.localeCompare(right))
  if (!init) return

  await withPrisma(async (prisma) => {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT "migration_name" FROM "_prisma_migrations"'
    ).catch(() => null)
    if (!rows || rows.length === 0) return

    // Only retired pre-squash names: a newer build's row, left by a rollback, is kept.
    const stale = rows
      .map((row) => row.migration_name)
      .filter((name) => !onDisk.has(name) && isPreSquashMigrationName(name))
    if (stale.length === 0) return

    // Only collapse a database that already carries the schema those rows built.
    const [{ present }] = await prisma.$queryRawUnsafe(
      `SELECT to_regclass('public."Tenant"') IS NOT NULL AS present`
    )
    if (!present) return

    const recorded = rows.some((row) => row.migration_name === init)
    await prisma.$executeRawUnsafe(
      'DELETE FROM "_prisma_migrations" WHERE "migration_name" = ANY($1::text[])',
      stale
    )
    if (!recorded) {
      const checksum = createHash('sha256')
        .update(readFileSync(path.join(migrationsDir, init, 'migration.sql')))
        .digest('hex')
      await prisma.$executeRawUnsafe(
        `INSERT INTO "_prisma_migrations"
           ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
         VALUES ($1, $2, now(), $3, NULL, NULL, now(), 1)`,
        randomUUID(),
        checksum,
        init
      )
    }
    process.stdout.write(`Collapsed ${stale.length} pre-squash migration row(s) onto ${init}.\n`)
  })
}

/** The history as rows: names applied, and the failed rows with their recorded errors. */
async function readMigrationHistory() {
  return await withPrisma(async (prisma) => {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT "migration_name", "logs", "finished_at", "rolled_back_at" FROM "_prisma_migrations"'
    ).catch(() => [])
    return {
      applied: rows.filter((row) => row.finished_at && !row.rolled_back_at).map((row) => row.migration_name),
      failed: rows.filter((row) => !row.finished_at && !row.rolled_back_at)
    }
  })
}

/** Prisma-only `DATABASE_URL` parameters libpq rejects (mirrors `server-backup-tools.ts`). */
const PRISMA_ONLY_URL_PARAMS = ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'socket_timeout', 'statement_cache_size', 'sslaccept', 'sslidentity', 'sslpassword']

/** `DATABASE_URL` without the Prisma-only parameters, for pg_dump and node-postgres. */
function libpqDatabaseUrl() {
  const url = new URL(process.env.DATABASE_URL ?? '')
  for (const param of PRISMA_ONLY_URL_PARAMS) url.searchParams.delete(param)
  return url.toString()
}

/**
 * The first error a migration's SQL raises against this database, found by replaying it inside a
 * transaction that is always rolled back, so nothing it does is kept. PostgreSQL stops a
 * multi-statement script at its first failure and returns that error, which is the real cause
 * even when Prisma recorded only "current transaction is aborted". Returns null when the replay
 * raised nothing.
 */
async function firstMigrationError(migrationName) {
  const sql = replayableMigrationSql(readFileSync(path.join(migrationsDir, migrationName, 'migration.sql'), 'utf8'))
  if (sql === null) return { code: 'not-replayable', message: 'the migration controls its own transaction' }
  const client = new pg.Client({ connectionString: libpqDatabaseUrl() })
  await client.connect()
  try {
    await client.query('BEGIN')
    try {
      await client.query(sql)
      return null
    } catch (error) {
      return { code: error.code, message: error.message }
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
    }
  } finally {
    await client.end().catch(() => undefined)
  }
}

/**
 * Whether the last object a migration creates already exists, proving the whole migration ran
 * before (see `lastCreatedObject`). False when the migration creates nothing recognizable.
 */
async function migrationObjectsPresent(migrationName) {
  const object = lastCreatedObject(readFileSync(path.join(migrationsDir, migrationName, 'migration.sql'), 'utf8'))
  if (!object) return false
  const client = new pg.Client({ connectionString: libpqDatabaseUrl() })
  await client.connect()
  try {
    const queries = {
      table: ["SELECT to_regclass(format('public.%I', $1::text)) IS NOT NULL AS present", [object.name]],
      index: ["SELECT to_regclass(format('public.%I', $1::text)) IS NOT NULL AS present", [object.name]],
      type: ['SELECT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = \'public\' AND t.typname = $1) AS present', [object.name]],
      constraint: ['SELECT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = \'public\' AND c.conname = $1) AS present', [object.name]],
      column: ['SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = \'public\' AND table_name = $1 AND column_name = $2) AS present', [object.table, object.name]]
    }
    const [text, values] = queries[object.kind]
    return (await client.query(text, values)).rows[0]?.present === true
  } finally {
    await client.end().catch(() => undefined)
  }
}

/**
 * Dumps the database to the backups folder before the history repair changes anything. Returns
 * the dump's path, or null when no dump could be made (no folder, no pg_dump, or it failed), in
 * which case the repair does not run.
 */
function backUpBeforeHistoryRepair() {
  const directory = process.env.BACKUPS_DIR ?? '/backups'
  if (!existsSync(directory)) {
    process.stdout.write(`[history-repair] No backups folder at ${directory}; not repairing without a backup.\n`)
    return null
  }
  // In a container, a folder that is not a mounted volume vanishes with the container, and the
  // image creates /backups whether or not a volume is attached.
  if (existsSync('/.dockerenv') && !isMountPoint(readFileSync('/proc/self/mountinfo', 'utf8'), directory)) {
    process.stdout.write(`[history-repair] The backups folder ${directory} is not a mounted volume, so a backup there would not survive the container; not repairing without a backup.\n`)
    return null
  }
  const file = path.join(directory, `pre-history-repair-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`)
  const result = spawnSync(process.env.PG_DUMP_PATH || 'pg_dump', ['--format=custom', `--file=${file}`, libpqDatabaseUrl()], { encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    process.stdout.write(`[history-repair] Could not back up the database first (${result.error?.message ?? result.stderr?.trim() ?? 'pg_dump failed'}); not repairing.\n`)
    return null
  }
  return file
}

/**
 * Repairs a history a rollback to 1.3.23 or earlier damaged (`isRollbackDamagedHistory`), one
 * migration at a time, never recording a migration whose SQL did not run here or before.
 *
 * Backs the database up first, then repeats: the failed migration failed only because what it
 * creates already exists, so it ran before the rollback and is recorded as applied; `migrate
 * deploy` then carries on. Migrations the database never had run normally, with all their SQL
 * (indexes, checks, backfills), so a database that was behind this build ends up exactly where
 * an ordinary upgrade would take it. Stops, leaving the rest for an administrator, as soon as a
 * failure is anything else. Each step is logged.
 *
 * @returns the last `migrate deploy` result, or null when the history is not the damaged shape
 *   or no backup could be made (nothing was changed).
 */
async function repairRollbackDamagedHistory() {
  const onDisk = listCheckedInMigrationNames(migrationsDir)
  let history = await readMigrationHistory()
  // The damaged shape, and a failure that is "already exists" when the migration is replayed.
  // The damaged shape, a failure that is "already exists" when the migration is replayed, and the
  // last object the migration creates already present (so all of it ran before the rollback).
  const isDamaged = async () => isRollbackDamagedHistory({ ...history, onDisk })
    && isAlreadyExistsError(await firstMigrationError(history.failed[0].migration_name))
    && await migrationObjectsPresent(history.failed[0].migration_name)
  if (!await isDamaged()) return null

  process.stdout.write('[history-repair] The migration history is behind the schema: migrations are failing because what they create already exists, the trace of a rollback to an older build that deleted history rows.\n')
  const backup = backUpBeforeHistoryRepair()
  if (!backup) return null
  process.stdout.write(`[history-repair] Backed up the database to ${backup}.\n`)

  let result = null
  for (let step = 0; step < onDisk.length && (step === 0 || await isDamaged()); step += 1) {
    const failed = history.failed[0].migration_name
    runPrisma(['migrate', 'resolve', '--applied', failed, '--schema', schemaPath])
    process.stdout.write(`[history-repair] Recorded ${failed} as applied: its objects were already present from before the rollback.\n`)
    result = runPrisma(['migrate', 'deploy', '--schema', schemaPath], { tolerateFailure: true })
    if ((result.status ?? 1) === 0) {
      process.stdout.write('[history-repair] The remaining migrations applied normally. Repair complete.\n')
      return result
    }
    history = await readMigrationHistory()
  }
  process.stdout.write('[history-repair] Stopped: the next failure is not one this repair recognizes.\n')
  return result
}

await collapsePreSquashMigrationHistory()

process.stdout.write('Applying database migrations...\n')
let migrateResult = runPrisma(['migrate', 'deploy', '--schema', schemaPath], { tolerateFailure: true })

if ((migrateResult.status ?? 1) !== 0 && !isNonEmptyDatabaseBaselineCase(migrateResult)) {
  const repaired = await repairRollbackDamagedHistory()
  if (repaired) {
    writePrismaOutput(migrateResult)
    migrateResult = repaired
  }
}

if (isNonEmptyDatabaseBaselineCase(migrateResult)) {
  await synchronizeSchemaWithBaseline(
    'Detected an existing database without Prisma migration history; falling back to prisma db push and baselining the checked-in migrations.\n'
  )
} else if (
  await hasOnlyMigrationHistoryTable()
  && (isRecoverableFreshInstallBaselineGap(migrateResult) || hasFailedMigrationState(migrateResult))
) {
  await resetFailedMigrationHistory()
  await synchronizeSchemaWithBaseline(
    'Detected a fresh database blocked by an incomplete checked-in migration baseline; clearing failed migration history, running prisma db push, and baselining the checked-in migrations.\n'
  )
} else if ((migrateResult.status ?? 1) === 0) {
  writePrismaOutput(migrateResult)
  process.stdout.write('Database migrations applied.\n')
} else {
  writePrismaOutput(migrateResult)
  const output = getPrismaOutput(migrateResult)
  throw new Error(output || 'Prisma migrate deploy failed.')
}
