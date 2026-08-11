/**
 * Boot-time restore safety: the marker lifecycle must never be able to loop a
 * boot into repeatedly dropping the database, and a marker whose backup went
 * missing must abort BEFORE anything destructive. The destructive halves
 * (drop/recreate + pg_restore) need a live Postgres and are exercised by the
 * operations runbook drill, not unit tests.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// The env module snapshots process.env at first import, so the backups dir
// must be pinned before any module under test loads (each test file runs in
// its own process under the node runner).
const backupsDir = mkdtempSync(path.join(tmpdir(), 'server-restore-'))
process.env.BACKUPS_DIR = backupsDir

const { applyStagedServerRestoreIfPending, readPendingRestoreMarker } = await import('./server-backup-restore.js')

test('no marker means an ordinary boot', async () => {
  assert.equal(await readPendingRestoreMarker(), null)
  assert.equal(await applyStagedServerRestoreIfPending(), null)
})

test('a marker whose backup is gone aborts without touching anything and does not loop', async () => {
  writeFileSync(
    path.join(backupsDir, 'restore-pending.json'),
    JSON.stringify({ version: 1, backupName: 'server-backup-gone', requestedAt: new Date().toISOString() })
  )

  const applied = await applyStagedServerRestoreIfPending()
  assert.equal(applied, null)
  // The pending marker is consumed (renamed to the failed marker), so the next
  // boot does not retry — a rejected restore must be re-staged deliberately.
  assert.ok(!existsSync(path.join(backupsDir, 'restore-pending.json')))
  assert.ok(!existsSync(path.join(backupsDir, 'restore-attempt.json')))
  assert.ok(existsSync(path.join(backupsDir, 'restore-failed.json')))

  const secondBoot = await applyStagedServerRestoreIfPending()
  assert.equal(secondBoot, null)

  rmSync(backupsDir, { recursive: true, force: true })
})
