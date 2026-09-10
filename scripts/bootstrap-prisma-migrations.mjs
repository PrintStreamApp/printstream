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
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'
import {
  getPrismaOutput,
  hasFailedMigrationState,
  isNonEmptyDatabaseBaselineCase,
  isRecoverableFreshInstallBaselineGap,
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

    const stale = rows.map((row) => row.migration_name).filter((name) => !onDisk.has(name))
    if (stale.length === 0) return

    // Only collapse a database that already carries the schema those rows built.
    const [{ present }] = await prisma.$queryRawUnsafe(
      `SELECT to_regclass('public."Tenant"') IS NOT NULL AS present`
    )
    if (!present) return

    const recorded = rows.some((row) => row.migration_name === init)
    await prisma.$executeRawUnsafe(
      `DELETE FROM "_prisma_migrations" WHERE "migration_name" <> $1`,
      init
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

await collapsePreSquashMigrationHistory()

process.stdout.write('Applying database migrations...\n')
const migrateResult = runPrisma(['migrate', 'deploy', '--schema', schemaPath], { tolerateFailure: true })

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
