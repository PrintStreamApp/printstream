import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { test } from 'node:test'
import { Client } from 'pg'
import {
  applyPendingMigrations,
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

test('selectPendingMigrations drops the already-applied names and keeps order', () => {
  // Synthetic rather than the checked-in list: how many migrations happen to be
  // checked in is not this function's contract, and a squash should not break it.
  const all = ['a_init', 'b_second', 'c_third'].map((name) => ({ name, sql: '--', checksum: 'x' }))
  const pending = selectPendingMigrations(all, new Set(['a_init', 'c_third']))
  assert.deepEqual(pending.map((migration) => migration.name), ['b_second'])
  assert.deepEqual(selectPendingMigrations(all, new Set()).map((migration) => migration.name), [
    'a_init',
    'b_second',
    'c_third'
  ])
  assert.deepEqual(selectPendingMigrations(all, new Set(['a_init', 'b_second', 'c_third'])), [])
})

test('the checked-in migrations replay from empty into exactly the current schema', async (t) => {
  // Stronger than the baseline.sql drift check this replaced: it proves the
  // MIGRATIONS (not a parallel snapshot) reproduce `schema.prisma` from empty,
  // which is the property that lets `migrate deploy` provision a fresh database
  // and `migrate dev` validate against a shadow database.
  const adminUrl = process.env.TEST_ADMIN_DATABASE_URL ?? toMaintenanceUrl(process.env.DATABASE_URL)
  if (!adminUrl || !(await canConnect(adminUrl))) {
    t.skip('no reachable Postgres (set TEST_ADMIN_DATABASE_URL)')
    return
  }

  const schemaPath = path.resolve(defaultMigrationsDir(), '..', 'schema.prisma')
  const repoRoot = path.resolve(schemaPath, '..', '..', '..', '..')
  // `migrate diff` replays into this database but will not create it (P1003).
  const shadowName = `printstream_shadow_${randomUUID().replace(/-/g, '')}`
  const admin = new Client({ connectionString: adminUrl })
  await admin.connect()
  await admin.query(`CREATE DATABASE "${shadowName}"`)

  try {
    const result = spawnSync(
      'npx',
      [
        'prisma', 'migrate', 'diff',
        '--from-migrations', defaultMigrationsDir(),
        '--to-schema-datamodel', schemaPath,
        '--shadow-database-url', withDatabaseName(adminUrl, shadowName),
        '--script'
      ],
      { encoding: 'utf8', cwd: repoRoot }
    )
    assert.equal(
      result.status,
      0,
      `prisma migrate diff failed: ${result.error?.message ?? result.stderr ?? 'unknown'}`
    )
    assert.match(
      result.stdout,
      /This is an empty migration/,
      `migrations do not reproduce schema.prisma; add a migration for the drift:\n${result.stdout}`
    )
  } finally {
    await admin
      .query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [shadowName])
      .catch(() => undefined)
    await admin.query(`DROP DATABASE IF EXISTS "${shadowName}"`).catch(() => undefined)
    await admin.end().catch(() => undefined)
  }
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
    assert.equal(first.baselined, false, 'a fresh database replays the history rather than baselining it')
    assert.deepEqual(
      first.applied,
      expected.map((migration) => migration.name),
      'every checked-in migration should run, starting with init'
    )

    // The recorded rows match the checked-in history and the schema exists.
    const probe = new Client({ connectionString: targetUrl })
    await probe.connect()
    try {
      const count = await probe.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL`
      )
      assert.equal(Number(count.rows[0]!.n), expected.length)
      // A representative table from the schema exists, and so does one from a
      // later part of the history (proving init is the full cumulative schema).
      const tables = await probe.query<{ workspace: boolean; orderprint: boolean }>(
        `SELECT to_regclass('public."Workspace"') IS NOT NULL AS workspace,
                to_regclass('public."OrderPrint"') IS NOT NULL AS orderprint`
      )
      assert.equal(tables.rows[0]!.workspace, true)
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

/**
 * The pre-squash upgrade, which is what every deployed database does exactly
 * once. Simulates the old world: the schema is present and the history names the
 * 66 migrations `00000000000000_init` replaced, one of them left FAILED — the
 * state that blocks `prisma migrate deploy` outright (P3009).
 */
test('applyPendingMigrations collapses a pre-squash history without re-running anything', async (t) => {
  const adminUrl = process.env.TEST_ADMIN_DATABASE_URL ?? toMaintenanceUrl(process.env.DATABASE_URL)
  if (!adminUrl || !(await canConnect(adminUrl))) {
    t.skip('no reachable Postgres (set TEST_ADMIN_DATABASE_URL)')
    return
  }

  const dbName = `printstream_legacytest_${randomUUID().replace(/-/g, '')}`
  const admin = new Client({ connectionString: adminUrl })
  await admin.connect()
  await admin.query(`CREATE DATABASE "${dbName}"`)
  const targetUrl = withDatabaseName(adminUrl, dbName)

  try {
    // Provision the schema, then rewrite history to look pre-squash.
    await applyPendingMigrations({ databaseUrl: targetUrl })
    const seed = new Client({ connectionString: targetUrl })
    await seed.connect()
    try {
      await seed.query(`DELETE FROM "_prisma_migrations"`)
      await seed.query(
        `INSERT INTO "_prisma_migrations"
           ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
         VALUES ($1, 'aa', now(), '20260505150000_platform_groups', NULL, NULL, now(), 1),
                ($2, 'bb', now(), '20260801070000_allow_workspace_invites', NULL, NULL, now(), 1),
                ($3, 'cc', NULL,  '20260519120000_filament_waste_stats', 'boom', NULL, now(), 0)`,
        [randomUUID(), randomUUID(), randomUUID()]
      )
    } finally {
      await seed.end().catch(() => undefined)
    }

    const onDisk = listMigrationFiles(defaultMigrationsDir()).map((migration) => migration.name)
    const result = await applyPendingMigrations({ databaseUrl: targetUrl })
    assert.equal(result.collapsedLegacyRows, 3, 'all three pre-squash rows should be discarded')
    assert.ok(
      !result.applied.includes(onDisk[0]!),
      'init must never re-run against a schema that already exists'
    )

    const probe = new Client({ connectionString: targetUrl })
    await probe.connect()
    try {
      const rows = await probe.query<{ migration_name: string; finished_at: Date | null }>(
        `SELECT "migration_name", "finished_at" FROM "_prisma_migrations" ORDER BY "migration_name"`
      )
      // Derived from the directory, not hard-coded: adding a migration later
      // must not turn this into a failure about the collapse.
      assert.deepEqual(
        rows.rows.map((row) => row.migration_name),
        onDisk,
        'history should end up naming exactly the checked-in migrations'
      )
      assert.ok(
        rows.rows.every((row) => row.finished_at),
        'no row may be left unfinished; a failed row blocks the Prisma CLI outright'
      )
      // The schema is untouched -- including the stats triggers, which no
      // datamodel snapshot carries and which a re-run would have rebuilt.
      const objects = await probe.query<{ triggers: string }>(
        `SELECT count(*)::text AS triggers FROM pg_trigger WHERE NOT tgisinternal`
      )
      assert.equal(Number(objects.rows[0]!.triggers), 6)
    } finally {
      await probe.end().catch(() => undefined)
    }

    const again = await applyPendingMigrations({ databaseUrl: targetUrl })
    assert.equal(again.collapsedLegacyRows, 0, 'collapsing is once-only')
    assert.deepEqual(again.applied, [])
  } finally {
    await admin
      .query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [dbName])
      .catch(() => undefined)
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`).catch(() => undefined)
    await admin.end().catch(() => undefined)
  }
})

/**
 * The stats rollups are database-side (functions + triggers), so nothing in the
 * TypeScript suite exercises them. This asserts a freshly provisioned database
 * actually rolls stats up, which catches two failure modes that both look fine
 * to a schema diff: triggers missing entirely (a datamodel snapshot cannot
 * express them), and `updatedAt` missing its database DEFAULT (the trigger
 * functions insert these rows without naming it, so the INSERT fails outright).
 */
test('a freshly provisioned database has working stats rollup triggers', async (t) => {
  const adminUrl = process.env.TEST_ADMIN_DATABASE_URL ?? toMaintenanceUrl(process.env.DATABASE_URL)
  if (!adminUrl || !(await canConnect(adminUrl))) {
    t.skip('no reachable Postgres (set TEST_ADMIN_DATABASE_URL)')
    return
  }

  const dbName = `printstream_statstest_${randomUUID().replace(/-/g, '')}`
  const admin = new Client({ connectionString: adminUrl })
  await admin.connect()
  await admin.query(`CREATE DATABASE "${dbName}"`)
  const targetUrl = withDatabaseName(adminUrl, dbName)

  try {
    await applyPendingMigrations({ databaseUrl: targetUrl })
    const probe = new Client({ connectionString: targetUrl })
    await probe.connect()
    try {
      await probe.query(
        `INSERT INTO "Workspace" ("id","slug","name","updatedAt") VALUES ('w1','alpha','Alpha',now())`
      )
      await probe.query(`INSERT INTO "AuthUser" ("id","email","updatedAt") VALUES ('u1','a@example.com',now())`)
      await probe.query(
        `INSERT INTO "AuthWorkspaceMembership" ("userId","workspaceId","updatedAt") VALUES ('u1','w1',now())`
      )

      const stats = await probe.query<{ n: string }>(`SELECT count(*)::text AS n FROM "WorkspaceStats"`)
      assert.equal(Number(stats.rows[0]!.n), 1, 'inserting a workspace should create its stats row')

      const platform = await probe.query<{ workspaces: number; users: number }>(
        `SELECT "workspaceCount" AS workspaces, "userCount" AS users FROM "PlatformStats" WHERE "id" = 'platform'`
      )
      assert.equal(platform.rows[0]?.workspaces, 1, 'platform workspace count should track the insert')
      assert.equal(platform.rows[0]?.users, 1, 'platform user count should track the membership')
    } finally {
      await probe.end().catch(() => undefined)
    }
  } finally {
    await admin
      .query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [dbName])
      .catch(() => undefined)
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`).catch(() => undefined)
    await admin.end().catch(() => undefined)
  }
})
