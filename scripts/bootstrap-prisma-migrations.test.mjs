import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  getPrismaOutput,
  hasFailedMigrationState,
  isAlreadyExistsError,
  isMountPoint,
  lastCreatedObject,
  replayableMigrationSql,
  isRollbackDamagedHistory,
  isNonEmptyDatabaseBaselineCase,
  isPreSquashMigrationName,
  isRecoverableFreshInstallBaselineGap,
  listCheckedInMigrationNames
} from './lib/bootstrap-prisma-migrations.mjs'

test('getPrismaOutput joins stdout and stderr', () => {
  assert.equal(getPrismaOutput({
    stdout: 'hello',
    stderr: 'world'
  }), 'hello\nworld')
})

test('isNonEmptyDatabaseBaselineCase detects Prisma P3005 output', () => {
  assert.equal(isNonEmptyDatabaseBaselineCase({
    status: 1,
    stdout: 'Error: P3005',
    stderr: ''
  }), true)
  assert.equal(isNonEmptyDatabaseBaselineCase({
    status: 0,
    stdout: 'Error: P3005',
    stderr: ''
  }), false)
})

test('isRecoverableFreshInstallBaselineGap detects the empty-db platform-groups failure', () => {
  assert.equal(isRecoverableFreshInstallBaselineGap({
    status: 1,
    stdout: 'Error: P3009\nERROR: relation "AuthGroup" does not exist',
    stderr: ''
  }), true)
  // First attempt on an empty database fails with P3018 before any retry
  // records a failed-migration state.
  assert.equal(isRecoverableFreshInstallBaselineGap({
    status: 1,
    stdout: 'Error: P3018\nERROR: relation "AuthGroup" does not exist',
    stderr: ''
  }), true)
  assert.equal(isRecoverableFreshInstallBaselineGap({
    status: 1,
    stdout: 'Error: P3009\nERROR: relation "SomeOtherTable" does not exist',
    stderr: ''
  }), false)
})

test('hasFailedMigrationState detects rerun Prisma P3009 failures', () => {
  assert.equal(hasFailedMigrationState({
    status: 1,
    stdout: 'Error: P3009\nThe `20260505150000_platform_groups` migration started at 2026-05-18 01:43:46 UTC failed',
    stderr: ''
  }), true)
  assert.equal(hasFailedMigrationState({
    status: 1,
    stdout: 'Error: P3018',
    stderr: ''
  }), false)
})

test('listCheckedInMigrationNames returns sorted migration directories only', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-prisma-migrations-'))
  try {
    await mkdir(path.join(tempDir, '20260508183000_bridge_library_scaffold'))
    await mkdir(path.join(tempDir, '20260505150000_platform_groups'))
    await writeFile(path.join(tempDir, 'migration_lock.toml'), '')

    assert.deepEqual(listCheckedInMigrationNames(tempDir), [
      '20260505150000_platform_groups',
      '20260508183000_bridge_library_scaffold'
    ])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})
test('only names dated before the squash are collapsed; a newer build\'s row is kept', () => {
  assert.equal(isPreSquashMigrationName('20260505150000_platform_groups'), true)
  assert.equal(isPreSquashMigrationName('20260801070000_allow_workspace_invites'), true)
  assert.equal(isPreSquashMigrationName('00000000000000_init'), false)
  assert.equal(isPreSquashMigrationName('20260801130000_rename_to_workspace_and_customer'), false)
  assert.equal(isPreSquashMigrationName('20261025000000_printer_fault_history'), false)
})

test('a first error is an already-exists failure only by its PostgreSQL code', () => {
  assert.equal(isAlreadyExistsError({ code: '42P07', message: 'relation "PrinterFault" already exists' }), true)
  assert.equal(isAlreadyExistsError({ code: '42710', message: 'type "TagEntityKind" already exists' }), true)
  assert.equal(isAlreadyExistsError({ code: '42701', message: 'column "kind" of relation "Workspace" already exists' }), true)
  assert.equal(isAlreadyExistsError({ code: '25P02', message: 'current transaction is aborted' }), false)
  assert.equal(isAlreadyExistsError({ code: '42P01', message: 'relation "AuthGroup" does not exist' }), false)
  assert.equal(isAlreadyExistsError(null), false)
})

const onDisk = [
  '00000000000000_init',
  '20260801130000_rename_to_workspace_and_customer',
  '20260910160000_prepared_slicing_source',
  '20261025000000_printer_fault_history',
  '20261201000000_some_later_migration'
]

test('the damaged shape is exactly the history a rollback to 1.3.23 or earlier leaves', () => {
  // 1.3.22 kept only init, re-ran the next migration (idempotent), and failed on the one after.
  assert.equal(isRollbackDamagedHistory({
    applied: ['00000000000000_init', '20260801130000_rename_to_workspace_and_customer'],
    failed: [{ migration_name: '20260910160000_prepared_slicing_source' }],
    onDisk
  }), true)
})

test('the damaged shape never matches a normal history or a newly added migration failing', () => {
  assert.equal(isRollbackDamagedHistory({ applied: onDisk, failed: [], onDisk }), false)
  assert.equal(isRollbackDamagedHistory({
    applied: onDisk.slice(0, 4),
    failed: [{ migration_name: '20261201000000_some_later_migration' }],
    onDisk
  }), false)
  // A gap in the applied rows, two failures, or an unknown row.
  assert.equal(isRollbackDamagedHistory({
    applied: ['00000000000000_init', '20260910160000_prepared_slicing_source'],
    failed: [{ migration_name: '20261025000000_printer_fault_history' }],
    onDisk
  }), false)
  assert.equal(isRollbackDamagedHistory({
    applied: ['00000000000000_init'],
    failed: [
      { migration_name: '20260801130000_rename_to_workspace_and_customer' },
      { migration_name: '20260910160000_prepared_slicing_source' }
    ],
    onDisk
  }), false)
  assert.equal(isRollbackDamagedHistory({
    applied: ['00000000000000_init', '20991231000000_unknown'],
    failed: [{ migration_name: '20260910160000_prepared_slicing_source' }],
    onDisk
  }), false)
})

test('a migration with its own BEGIN and COMMIT lines is replayed without them; other control is refused', () => {
  const own = 'BEGIN;\nCREATE TYPE "Kind" AS ENUM (\'a\');\nCOMMIT;\n'
  assert.equal(replayableMigrationSql(own).includes('BEGIN;'), false)
  assert.equal(replayableMigrationSql(own).includes('COMMIT;'), false)
  assert.equal(replayableMigrationSql('CREATE TABLE "A" ();\nROLLBACK;\n'), null)
  // PL/pgSQL blocks keep their BEGIN and END.
  const block = 'DO $$\nBEGIN\n  PERFORM 1;\nEND;\n$$;\n'
  assert.equal(replayableMigrationSql(block), block)
})

test('the last object a migration creates is what proves all of it ran', () => {
  const sql = [
    '-- CREATE TABLE "Commented" (id int);',
    'CREATE TABLE "PrinterFault" ("id" TEXT);',
    'CREATE UNIQUE INDEX "PrinterFault_workspaceId_id_key" ON "PrinterFault"("id");',
    'ALTER TABLE "PrinterFault" ADD CONSTRAINT "PrinterFault_source_check" CHECK (true);',
    'UPDATE "PrinterFault" SET "id" = "id";'
  ].join('\n')
  assert.deepEqual(lastCreatedObject(sql), { kind: 'constraint', name: 'PrinterFault_source_check' })
  assert.deepEqual(lastCreatedObject('ALTER TABLE "AuthUser" ADD COLUMN IF NOT EXISTS "locale" TEXT;'), { kind: 'column', table: 'AuthUser', name: 'locale' })
  assert.equal(lastCreatedObject('UPDATE "A" SET "b" = 1;'), null)
})

test('a backups folder counts as kept only when it is a mount point', () => {
  const mountinfo = [
    '612 580 0:52 / / rw,relatime - overlay overlay rw',
    '640 612 259:2 /srv/backups /backups rw,relatime - ext4 /dev/nvme0n1p2 rw'
  ].join('\n')
  assert.equal(isMountPoint(mountinfo, '/backups'), true)
  assert.equal(isMountPoint(mountinfo, '/backups/'), true)
  assert.equal(isMountPoint(mountinfo, '/data'), false)
})
