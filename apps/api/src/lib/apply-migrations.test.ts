import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { Client } from 'pg'
import {
  applyPendingMigrations,
  defaultBaselineSqlPath,
  defaultMigrationsDir,
  listMigrationFiles,
  migrationChecksum,
  selectPendingMigrations
} from './apply-migrations.js'

test('migrationChecksum is a stable 64-char hex sha256', () => {
  const checksum = migrationChecksum('CREATE TABLE "x" ();')
  assert.match(checksum, /^[0-9a-f]{64}$/)
  // Hashing the buffer and the equivalent string must agree (the applier reads
  // bytes for the checksum but a string for execution).
  assert.equal(migrationChecksum(Buffer.from('CREATE TABLE "x" ();', 'utf8')), checksum)
})

test('listMigrationFiles returns the checked-in migrations sorted by name', () => {
  const migrations = listMigrationFiles(defaultMigrationsDir())
  assert.ok(migrations.length > 0, 'expected at least one checked-in migration')
  const names = migrations.map((migration) => migration.name)
  assert.deepEqual(names, [...names].sort((left, right) => left.localeCompare(right)))
  for (const migration of migrations) {
    assert.match(migration.checksum, /^[0-9a-f]{64}$/)
    assert.ok(migration.sql.length > 0, `${migration.name} has empty SQL`)
  }
})

test('selectPendingMigrations drops the already-applied names', () => {
  const all = listMigrationFiles(defaultMigrationsDir())
  const applied = new Set([all[0]!.name, all[1]!.name])
  const pending = selectPendingMigrations(all, applied)
  assert.equal(pending.length, all.length - 2)
  assert.ok(!pending.some((migration) => applied.has(migration.name)))
})

test('the checked-in baseline.sql matches the current schema (regenerate with `npm run prisma:baseline`)', (t) => {
  const schemaPath = path.resolve(defaultMigrationsDir(), '..', 'schema.prisma')
  const result = spawnSync(
    'npx',
    ['prisma', 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', schemaPath, '--script'],
    { encoding: 'utf8', cwd: path.resolve(schemaPath, '..', '..') }
  )
  if (result.status !== 0 || !result.stdout) {
    // The schema engine isn't runnable in this environment; drift is still
    // caught wherever the Prisma CLI is available (CI runs the full validate).
    t.skip(`prisma CLI unavailable: ${result.error?.message ?? result.stderr ?? 'unknown'}`)
    return
  }
  const checkedIn = readFileSync(defaultBaselineSqlPath(), 'utf8')
  assert.equal(result.stdout, checkedIn, 'baseline.sql is stale; run `npm run prisma:baseline`')
})

/**
 * Integration: provision a throwaway database from baseline, then prove
 * idempotency. Gated on a reachable Postgres so the unit suite stays green in CI
 * without a database — set TEST_ADMIN_DATABASE_URL (or DATABASE_URL) to a cluster
 * where we may CREATE/DROP DATABASE to exercise it.
 */
test('applyPendingMigrations baselines a fresh database then is a no-op', async (t) => {
  const adminUrl = process.env.TEST_ADMIN_DATABASE_URL ?? toMaintenanceUrl(process.env.DATABASE_URL)
  if (!adminUrl || !(await canConnect(adminUrl))) {
    t.skip('no reachable Postgres (set TEST_ADMIN_DATABASE_URL)')
    return
  }

  const dbName = `printstream_migtest_${randomUUID().replace(/-/g, '')}`
  const admin = new Client({ connectionString: adminUrl })
  await admin.connect()
  await admin.query(`CREATE DATABASE "${dbName}"`)
  const targetUrl = withDatabaseName(adminUrl, dbName)

  try {
    const expected = listMigrationFiles(defaultMigrationsDir())

    const first = await applyPendingMigrations({ databaseUrl: targetUrl })
    assert.equal(first.baselined, true, 'a fresh database should be materialized from the baseline')
    assert.deepEqual(
      first.applied,
      expected.map((migration) => migration.name),
      'every checked-in migration should be baseline-marked'
    )

    // The recorded rows match the checked-in history and the schema exists.
    const probe = new Client({ connectionString: targetUrl })
    await probe.connect()
    try {
      const count = await probe.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL`
      )
      assert.equal(Number(count.rows[0]!.n), expected.length)
      // A representative table from the schema exists, and so does one created by
      // a later migration (proving the baseline is the full cumulative schema).
      const tables = await probe.query<{ tenant: boolean; orderprint: boolean }>(
        `SELECT to_regclass('public."Tenant"') IS NOT NULL AS tenant,
                to_regclass('public."OrderPrint"') IS NOT NULL AS orderprint`
      )
      assert.equal(tables.rows[0]!.tenant, true)
      assert.equal(tables.rows[0]!.orderprint, true)
    } finally {
      await probe.end().catch(() => undefined)
    }

    const second = await applyPendingMigrations({ databaseUrl: targetUrl })
    assert.equal(second.baselined, false)
    assert.deepEqual(second.applied, [], 'second run should be a no-op')
    assert.equal(second.alreadyApplied.length, expected.length)
  } finally {
    // Terminate lingering connections so DROP DATABASE succeeds.
    await admin
      .query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [dbName])
      .catch(() => undefined)
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`).catch(() => undefined)
    await admin.end().catch(() => undefined)
  }
})

/** Swap whatever database a URL points at for the `postgres` maintenance DB. */
function toMaintenanceUrl(databaseUrl: string | undefined): string | undefined {
  if (!databaseUrl) return undefined
  return withDatabaseName(databaseUrl, 'postgres')
}

function withDatabaseName(databaseUrl: string, dbName: string): string {
  const url = new URL(databaseUrl)
  url.pathname = `/${dbName}`
  return url.toString()
}

async function canConnect(databaseUrl: string): Promise<boolean> {
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 1500 })
  try {
    await client.connect()
    await client.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => undefined)
  }
}
