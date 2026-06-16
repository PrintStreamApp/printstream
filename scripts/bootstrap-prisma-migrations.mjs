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
