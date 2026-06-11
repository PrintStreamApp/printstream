import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  getPrismaOutput,
  hasFailedMigrationState,
  isNonEmptyDatabaseBaselineCase,
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