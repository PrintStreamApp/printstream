/**
 * The repair migration must stay safe to run on a database that needs none of it.
 *
 * It exists because the squash left both hosted deployments short of the
 * datamodel (see its own header), so it runs against every database on every
 * deploy — including the overwhelming majority that were built by `init` and
 * already have everything. One unguarded `CREATE TABLE` or `ADD COLUMN` in
 * there fails the deploy for all of them, and the failure surfaces as a
 * container that will not start rather than as a test.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url))

/**
 * Every repair migration, found by name rather than listed.
 *
 * A second one was needed within the hour (nullability and leftover columns,
 * which the first pass's column-existence check could not see), so a hardcoded
 * path would have left it unguarded exactly when it mattered.
 */
function repairMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.includes('repair_pre_squash'))
    .map((name) => `${MIGRATIONS_DIR}${name}/migration.sql`)
}

const CUSTOMERS_MIGRATION = fileURLToPath(
  new URL('./migrations/20260801220000_repair_pre_squash_customers/migration.sql', import.meta.url)
)

/** The file with `--` comments removed, so prose cannot satisfy a check. */
function statementsIn(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
}

/** Statements across every repair migration. */
function statements(): string[] {
  return repairMigrations().flatMap(statementsIn)
}

test('every CREATE TABLE in the repair migration is guarded', () => {
  for (const statement of statements()) {
    if (!/^CREATE TABLE/i.test(statement)) continue
    assert.match(statement, /^CREATE TABLE IF NOT EXISTS/i, `unguarded: ${statement.slice(0, 60)}`)
  }
})

test('every CREATE INDEX in the repair migration is guarded', () => {
  for (const statement of statements()) {
    if (!/^CREATE (UNIQUE )?INDEX/i.test(statement)) continue
    assert.match(statement, /IF NOT EXISTS/i, `unguarded: ${statement.slice(0, 60)}`)
  }
})

test('every ADD COLUMN in the repair migration is guarded', () => {
  for (const statement of statements()) {
    if (!/ADD COLUMN/i.test(statement)) continue
    assert.match(statement, /ADD COLUMN IF NOT EXISTS/i, `unguarded: ${statement.slice(0, 60)}`)
  }
})

test('constraints are added only inside an existence check', () => {
  // Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so the only safe form is a
  // `DO $$` block testing `pg_constraint` first. A bare ADD CONSTRAINT would
  // throw `already exists` on every healthy database.
  for (const statement of statements()) {
    if (!/ADD CONSTRAINT/i.test(statement)) continue
    assert.match(
      statement,
      /pg_constraint/,
      `ADD CONSTRAINT outside an existence check: ${statement.slice(0, 60)}`
    )
  }
})

test('the repair migration still covers what the squash retired', () => {
  // Pins the list, so removing a repair silently is not possible. These are the
  // objects observed missing on a deployed database after the squashed chain
  // applied successfully.
  const sql = readFileSync(CUSTOMERS_MIGRATION, 'utf8')
  for (const required of [
    '"Customer"',
    '"CustomerMembership"',
    '"Workspace" ADD COLUMN IF NOT EXISTS "customerId"',
    '"Workspace" ADD COLUMN IF NOT EXISTS "kind"',
    '"License" ADD COLUMN IF NOT EXISTS "customerId"',
    '"PendingRegistration" ADD COLUMN IF NOT EXISTS "workspaceKind"'
  ]) {
    assert.ok(sql.includes(required), `repair migration no longer covers ${required}`)
  }
})

test('a repair migration never drops a column without checking it is empty', () => {
  // The one irreversible thing these can do. Both DROPs were written only after
  // confirming the column was empty on staging AND production, but the count is
  // re-checked at run time so a deployment whose history differs from those two
  // cannot lose data to it.
  //
  // Matched per COLUMN rather than per statement: the guard lives in a `DO $$`
  // block, which a naive split on `;` tears into fragments that each look
  // unguarded on their own.
  for (const file of repairMigrations()) {
    const sql = readFileSync(file, 'utf8')
    for (const [, column] of sql.matchAll(/DROP COLUMN(?! IF EXISTS)\s+"([^"]+)"/gi)) {
      assert.ok(
        new RegExp(`count\\("${column}"\\)`, 'i').test(sql),
        `${file} drops "${column}" with no count("${column}") emptiness check`
      )
    }
    // And it has to say so when it declines, or a skipped drop is invisible.
    if (/DROP COLUMN(?! IF EXISTS)/i.test(sql)) {
      assert.match(sql, /RAISE WARNING/, `${file} drops a column but never reports leaving one in place`)
    }
  }
})

test('every repair migration is discovered by the guards', () => {
  // Fails if the naming convention is broken, rather than silently guarding
  // nothing -- the failure mode a hardcoded list already had once.
  const found = repairMigrations()
  assert.ok(found.length >= 2, `expected the repair migrations to be found, got ${found.length}`)
})
