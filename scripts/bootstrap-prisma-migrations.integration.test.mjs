/**
 * The Docker migration bootstrap through a rollback: a database rolled back to 1.3.22 (whose
 * cleanup deleted every history row but init, then re-ran the migrations into the existing tables
 * and recorded a failure), then upgraded to this build. Covers a database that was on 1.3.23 and
 * one that was behind it, and compares the whole schema (tables, columns, indexes, constraints,
 * triggers) with a fresh install, so no migration is recorded without its SQL having run. Runs the real bootstrap script and
 * Prisma CLI against a scratch database; skipped without a reachable Postgres
 * (TEST_ADMIN_DATABASE_URL), and failed instead when PRINTSTREAM_REQUIRE_TEST_DATABASE=1.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const schemaPath = path.join(repoRoot, 'apps/api/prisma/schema.prisma')
const adminUrl = process.env.TEST_ADMIN_DATABASE_URL

/** Runs a command in the repo with the scratch database and extra environment. */
function run(command, args, env) {
  return spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ...env } })
}

/** The bootstrap the Docker image runs at every start. */
function bootstrap(env) {
  return run(process.execPath, ['scripts/bootstrap-prisma-migrations.mjs'], env)
}

/** A stand-in for pg_dump that writes the file it was asked for, so the test needs no client tools. */
function fakePgDump(directory) {
  const file = path.join(directory, 'fake-pg-dump.mjs')
  writeFileSync(file, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs'\nconst target = process.argv.find((arg) => arg.startsWith('--file='))\nwriteFileSync(target.slice('--file='.length), 'dump')\n`)
  chmodSync(file, 0o755)
  return file
}

/** Every schema object a migration can create, as sorted names, to compare databases. */
async function schemaSnapshot(db) {
  const query = async (sql) => (await db.query(sql)).rows.map((row) => row.name).sort()
  return {
    columns: await query(`SELECT table_name || '.' || column_name || ':' || data_type AS name FROM information_schema.columns WHERE table_schema = 'public'`),
    indexes: await query(`SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public'`),
    constraints: await query(`SELECT conname AS name FROM pg_constraint JOIN pg_namespace ON pg_namespace.oid = connamespace WHERE nspname = 'public'`),
    triggers: await query('SELECT tgname AS name FROM pg_trigger WHERE NOT tgisinternal')
  }
}

/**
 * Provisions a scratch database, runs `body` with its URL and a connected client, and drops it.
 */
async function withScratchDatabase(t, body) {
  if (!adminUrl) {
    if (process.env.PRINTSTREAM_REQUIRE_TEST_DATABASE === '1') assert.fail('TEST_ADMIN_DATABASE_URL is required')
    t.skip('no reachable Postgres (set TEST_ADMIN_DATABASE_URL)')
    return
  }
  const dbName = `printstream_bootstraptest_${randomUUID().replace(/-/g, '')}`
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  await admin.query(`CREATE DATABASE "${dbName}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${dbName}`
  const scratch = mkdtempSync(path.join(tmpdir(), 'printstream-bootstrap-'))
  const db = new pg.Client({ connectionString: url.toString() })
  try {
    await body({ DATABASE_URL: url.toString(), db, scratch })
  } finally {
    await db.end().catch(() => undefined)
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [dbName]).catch(() => undefined)
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`).catch(() => undefined)
    await admin.end().catch(() => undefined)
    if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true })
  }
}

/** The history rows, oldest first, with whether each finished. */
async function readHistory(db) {
  return (await db.query(
    'SELECT "migration_name", "finished_at" IS NOT NULL AS done FROM "_prisma_migrations" ORDER BY "migration_name"'
  )).rows
}

/** What a 1.3.22 start does: delete every row but init, then `migrate deploy` into the tables. */
async function rollBackTo1322(db, DATABASE_URL) {
  await db.query(`DELETE FROM "_prisma_migrations" WHERE "migration_name" <> '00000000000000_init'`)
  assert.notEqual(run(path.join(repoRoot, 'node_modules/.bin/prisma'), ['migrate', 'deploy', '--schema', schemaPath], { DATABASE_URL }).status, 0)
  const damaged = await readHistory(db)
  assert.equal(damaged.filter((row) => !row.done).length, 1, 'one failed row, as 1.3.22 leaves it')
  return damaged
}

test('a Docker install rolled back from 1.3.23 to 1.3.22 repairs its history on the next upgrade, after a backup', async (t) => {
  await withScratchDatabase(t, async ({ DATABASE_URL, db, scratch }) => {
    // 1.3.23: a normal install, every migration applied.
    assert.equal(bootstrap({ DATABASE_URL }).status, 0)
    await db.connect()
    const full = await readHistory(db)
    const schema = await schemaSnapshot(db)

    const damaged = await rollBackTo1322(db, DATABASE_URL)

    // This build, with nowhere to put a backup: it refuses to repair and changes nothing.
    const refused = bootstrap({ DATABASE_URL, BACKUPS_DIR: path.join(scratch, 'missing') })
    assert.notEqual(refused.status, 0)
    assert.match(refused.stdout, /not repairing without a backup/)
    assert.deepEqual(await readHistory(db), damaged)

    // With a backup folder: backs up, repairs, and logs each step.
    const backups = path.join(scratch, 'backups')
    mkdirSync(backups)
    const repaired = bootstrap({ DATABASE_URL, BACKUPS_DIR: backups, PG_DUMP_PATH: fakePgDump(scratch) })
    assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr)
    assert.match(repaired.stdout, /\[history-repair\] Backed up the database/)
    assert.match(repaired.stdout, /\[history-repair\] Recorded \S+ as applied/)
    assert.match(repaired.stdout, /Repair complete/)
    assert.equal(readdirSync(backups).filter((name) => name.startsWith('pre-history-repair-')).length, 1)
    // Prisma keeps each resolved failure as a rolled-back row beside its applied one; what counts
    // is that every checked-in migration is applied, once, and nothing is left failed.
    const applied = (await db.query(
      'SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL ORDER BY "migration_name"'
    )).rows.map((row) => row.migration_name)
    assert.deepEqual(applied, full.map((row) => row.migration_name))
    assert.equal((await db.query('SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL')).rows[0].n, 0)
    assert.deepEqual(await schemaSnapshot(db), schema, 'the schema is exactly a fresh install\'s')

    // And the next start is an ordinary one.
    const next = bootstrap({ DATABASE_URL })
    assert.equal(next.status, 0)
    assert.doesNotMatch(next.stdout, /history-repair/)
  })
})

test('a database behind 1.3.23 when it was damaged gets the newer migrations run in full', async (t) => {
  await withScratchDatabase(t, async ({ DATABASE_URL, db, scratch }) => {
    assert.equal(bootstrap({ DATABASE_URL }).status, 0)
    await db.connect()
    const schema = await schemaSnapshot(db)

    // Take it back to before the fault-history migration (1.3.22's schema), then damage it.
    for (const table of ['PrinterFaultJobSpan', 'PrinterFaultIdlePeriod', 'PrintJobFault', 'PrinterFaultGap', 'PrinterFault']) {
      await db.query(`DROP TABLE "${table}"`)
    }
    await db.query('DROP INDEX "Printer_workspaceId_id_key"')
    await db.query('DROP INDEX "PrintJob_workspaceId_id_key"')
    await db.query(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261025000000_printer_fault_history'`)
    await rollBackTo1322(db, DATABASE_URL)

    const backups = path.join(scratch, 'backups')
    mkdirSync(backups)
    const repaired = bootstrap({ DATABASE_URL, BACKUPS_DIR: backups, PG_DUMP_PATH: fakePgDump(scratch) })
    assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr)
    assert.doesNotMatch(repaired.stdout, /Recorded 20261025000000_printer_fault_history/, 'never recorded without running')
    // The migration's raw SQL ran: its partial unique index and checks exist, as on a fresh install.
    const after = await schemaSnapshot(db)
    assert.ok(after.indexes.includes('PrinterFault_open_source_code_key'))
    assert.ok(after.constraints.includes('PrinterFault_source_check'))
    assert.deepEqual(after, schema)
  })
})
