import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { BridgeBackupStatus } from '@printstream/shared'
import {
  getBridgeBackupStatus,
  initBridgeBackups,
  listBridgeBackupSnapshots,
  onBridgeBackupStatusChange,
  startBridgeBackup,
  stopBridgeBackupScheduler,
  waitForBridgeBackupIdle
} from './backup-manager.js'

let root: string | null = null

async function configureFixture(overrides?: { intervalHours?: number }) {
  root = mkdtempSync(path.join(tmpdir(), 'bridge-backup-mgr-'))
  const libraryDir = path.join(root, 'library')
  const backupDir = path.join(root, 'backups')
  const stateFilePath = path.join(root, 'bridge-state.json')
  mkdirSync(libraryDir, { recursive: true })
  writeFileSync(stateFilePath, JSON.stringify({ installationId: 'install-1' }))
  const filePath = path.join(libraryDir, 'file.3mf')
  writeFileSync(filePath, 'bytes')
  const settled = new Date(Date.now() - 10 * 60_000)
  utimesSync(filePath, settled, settled)
  await initBridgeBackups({
    backupDir,
    libraryDir,
    stateFilePath,
    intervalHours: overrides?.intervalHours ?? 24
  })
  return { libraryDir, backupDir, stateFilePath }
}

afterEach(async () => {
  await waitForBridgeBackupIdle()
  stopBridgeBackupScheduler()
  onBridgeBackupStatusChange(null)
  // Reset to the unconfigured state so other test files see a clean module.
  await initBridgeBackups({ backupDir: undefined as unknown as string })
  if (root) {
    rmSync(root, { recursive: true, force: true })
    root = null
  }
})

test('status reports unconfigured when no backup dir is set', async () => {
  await initBridgeBackups({ backupDir: undefined as unknown as string })
  const status = getBridgeBackupStatus()
  assert.equal(status.configured, false)
  assert.equal(status.directory, null)
})

test('a manual run transitions running -> complete and pushes both statuses', async () => {
  const fixture = await configureFixture()
  const seen: BridgeBackupStatus[] = []
  onBridgeBackupStatusChange((status) => seen.push(status))

  const immediate = startBridgeBackup('manual')
  assert.equal(immediate.running, true)
  await waitForBridgeBackupIdle()

  assert.equal(seen.length, 2)
  assert.equal(seen[0]?.running, true)
  assert.equal(seen[1]?.running, false)
  assert.equal(seen[1]?.lastError, null)
  assert.equal(seen[1]?.snapshotCount, 1)
  assert.ok(seen[1]?.lastBackupAt)
  assert.equal(getBridgeBackupStatus().directory, fixture.backupDir)

  const snapshots = await listBridgeBackupSnapshots()
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0]?.trigger, 'manual')
})

test('a second start while running is a no-op', async () => {
  await configureFixture()
  startBridgeBackup('manual')
  startBridgeBackup('manual')
  await waitForBridgeBackupIdle()
  const snapshots = await listBridgeBackupSnapshots()
  assert.equal(snapshots.length, 1)
})

test('a failing backup lands in lastError instead of throwing', async () => {
  const fixture = await configureFixture()
  // A regular FILE where the backup dir should go makes every mkdir fail.
  const blocker = path.join(root!, 'blocker')
  writeFileSync(blocker, 'not a directory')
  await initBridgeBackups({
    backupDir: path.join(blocker, 'backups'),
    libraryDir: fixture.libraryDir,
    stateFilePath: fixture.stateFilePath,
    intervalHours: 24
  })
  startBridgeBackup('manual')
  await waitForBridgeBackupIdle()
  const status = getBridgeBackupStatus()
  assert.equal(status.running, false)
  assert.ok(status.lastError, 'failure is reported through status')
})

test('a backup dir overlapping the library is refused at init', async () => {
  root = mkdtempSync(path.join(tmpdir(), 'bridge-backup-mgr-'))
  const libraryDir = path.join(root, 'library')
  mkdirSync(libraryDir, { recursive: true })
  await initBridgeBackups({
    backupDir: path.join(libraryDir, 'backups'),
    libraryDir,
    stateFilePath: path.join(root, 'bridge-state.json'),
    intervalHours: 24
  })
  const status = getBridgeBackupStatus()
  assert.equal(status.configured, true)
  assert.match(status.lastError ?? '', /overlaps the library directory/)
  // Runs are refused while misconfigured.
  const after = startBridgeBackup('manual')
  assert.equal(after.running, false)
})

test('manual-only mode reports no next due time', async () => {
  await configureFixture({ intervalHours: 0 })
  const status = getBridgeBackupStatus()
  assert.equal(status.intervalHours, 0)
  assert.equal(status.nextDueAt, null)
})
