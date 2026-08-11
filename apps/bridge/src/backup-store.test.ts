import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, utimesSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createBackupSnapshot,
  listBackupSnapshots,
  pruneBackupSnapshots,
  validateBackupDirectory
} from './backup-store.js'

const DAY_MS = 24 * 60 * 60 * 1000

let root: string | null = null

interface Fixture {
  libraryDir: string
  backupDir: string
  stateFilePath: string
}

function newFixture(): Fixture {
  root = mkdtempSync(path.join(tmpdir(), 'bridge-backup-'))
  const libraryDir = path.join(root, 'data', 'library')
  const backupDir = path.join(root, 'backups')
  const stateFilePath = path.join(root, 'data', 'bridge-state.json')
  mkdirSync(libraryDir, { recursive: true })
  writeFileSync(stateFilePath, JSON.stringify({ installationId: 'install-1', runtimeToken: 'secret' }))
  return { libraryDir, backupDir, stateFilePath }
}

/** Writes a library file whose mtime sits safely outside the quiesce window. */
function writeSettledFile(libraryDir: string, name: string, content: string, nowMs: number): void {
  const filePath = path.join(libraryDir, name)
  writeFileSync(filePath, content)
  const settled = new Date(nowMs - 10 * 60_000)
  utimesSync(filePath, settled, settled)
}

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
    root = null
  }
})

test('a snapshot captures the state file and library, excluding replicas', async () => {
  const fixture = newFixture()
  const nowMs = Date.now()
  writeSettledFile(fixture.libraryDir, '100-model.3mf', 'model-bytes', nowMs)
  writeSettledFile(fixture.libraryDir, 'replica-abc-file.3mf', 'replica-bytes', nowMs)

  const { snapshot } = await createBackupSnapshot({ ...fixture, trigger: 'manual', now: () => nowMs })

  const snapshotDir = path.join(fixture.backupDir, snapshot.name)
  assert.equal(readFileSync(path.join(snapshotDir, 'library', '100-model.3mf'), 'utf8'), 'model-bytes')
  assert.ok(!existsSync(path.join(snapshotDir, 'library', 'replica-abc-file.3mf')))
  const stateCopy = path.join(snapshotDir, 'bridge-state.json')
  assert.match(readFileSync(stateCopy, 'utf8'), /install-1/)
  if (process.platform !== 'win32') {
    assert.equal(statSync(stateCopy).mode & 0o777, 0o600)
  }
  assert.equal(snapshot.trigger, 'manual')
  assert.equal(snapshot.fileCount, 1)
  assert.ok(snapshot.copiedBytes > 0)
})

test('a file still being written is skipped, not half-copied', async () => {
  const fixture = newFixture()
  const nowMs = Date.now()
  writeSettledFile(fixture.libraryDir, 'settled.3mf', 'done', nowMs)
  // Freshly-written file: mtime is "now", inside the quiesce window.
  writeFileSync(path.join(fixture.libraryDir, 'uploading.3mf'), 'partial')

  const { snapshot } = await createBackupSnapshot({ ...fixture, trigger: 'scheduled', now: () => nowMs })

  const snapshotDir = path.join(fixture.backupDir, snapshot.name)
  assert.ok(existsSync(path.join(snapshotDir, 'library', 'settled.3mf')))
  assert.ok(!existsSync(path.join(snapshotDir, 'library', 'uploading.3mf')))
  assert.equal(snapshot.skippedInFlightCount, 1)
})

test('an unchanged file is hardlinked to the previous snapshot, a changed one re-copied', async () => {
  const fixture = newFixture()
  const firstNow = Date.now()
  writeSettledFile(fixture.libraryDir, 'stable.3mf', 'stable-bytes', firstNow)
  writeSettledFile(fixture.libraryDir, 'changed.3mf', 'v1', firstNow)
  const first = await createBackupSnapshot({ ...fixture, trigger: 'scheduled', now: () => firstNow })

  const secondNow = firstNow + 60 * 60_000
  writeSettledFile(fixture.libraryDir, 'changed.3mf', 'v2-different', secondNow)
  const second = await createBackupSnapshot({ ...fixture, trigger: 'scheduled', now: () => secondNow })

  const firstStable = statSync(path.join(fixture.backupDir, first.snapshot.name, 'library', 'stable.3mf'))
  const secondStable = statSync(path.join(fixture.backupDir, second.snapshot.name, 'library', 'stable.3mf'))
  assert.equal(firstStable.ino, secondStable.ino, 'unchanged file should share an inode across snapshots')
  assert.equal(
    readFileSync(path.join(fixture.backupDir, second.snapshot.name, 'library', 'changed.3mf'), 'utf8'),
    'v2-different'
  )
  // Only the changed file's bytes were copied on the second run (plus no state-file change tracking).
  assert.ok(second.snapshot.copiedBytes < first.snapshot.copiedBytes + 'v2-different'.length)
})

test('a crashed run leaves no directory that looks like a completed snapshot', async () => {
  const fixture = newFixture()
  const nowMs = Date.now()
  // A stale .partial from a "crashed" earlier run.
  mkdirSync(path.join(fixture.backupDir, 'backup-stale.partial', 'library'), { recursive: true })

  writeSettledFile(fixture.libraryDir, 'file.3mf', 'bytes', nowMs)
  await createBackupSnapshot({ ...fixture, trigger: 'scheduled', now: () => nowMs })

  const entries = readdirSync(fixture.backupDir)
  assert.ok(!entries.some((name) => name.endsWith('.partial')), '.partial leftovers are swept')
  const snapshots = await listBackupSnapshots(fixture.backupDir)
  assert.equal(snapshots.length, 1)
})

test('listBackupSnapshots returns snapshots newest first and skips junk', async () => {
  const fixture = newFixture()
  const base = Date.now()
  writeSettledFile(fixture.libraryDir, 'file.3mf', 'bytes', base)
  await createBackupSnapshot({ ...fixture, trigger: 'scheduled', now: () => base - DAY_MS })
  await createBackupSnapshot({ ...fixture, trigger: 'manual', now: () => base })
  // Junk dir without a manifest is ignored.
  mkdirSync(path.join(fixture.backupDir, 'backup-junk'))

  const snapshots = await listBackupSnapshots(fixture.backupDir)
  assert.equal(snapshots.length, 2)
  assert.equal(snapshots[0]?.trigger, 'manual')
  assert.ok(Date.parse(snapshots[0]!.createdAt) > Date.parse(snapshots[1]!.createdAt))
})

test('retention prunes old snapshots after a successful backup', async () => {
  const fixture = newFixture()
  const base = Date.now()
  writeSettledFile(fixture.libraryDir, 'file.3mf', 'bytes', base)
  // Two snapshots in the same old weekly bucket: the newer of the pair is pruned.
  await createBackupSnapshot({ ...fixture, trigger: 'scheduled', now: () => base - 13 * DAY_MS })
  await createBackupSnapshot({ ...fixture, trigger: 'scheduled', now: () => base - 12 * DAY_MS })

  const pruned = await pruneBackupSnapshots(fixture.backupDir, base)
  assert.equal(pruned, 1)
  const snapshots = await listBackupSnapshots(fixture.backupDir)
  assert.equal(snapshots.length, 1)
  assert.equal(
    Math.round((base - Date.parse(snapshots[0]!.createdAt)) / DAY_MS),
    13,
    'the oldest snapshot in the bucket survives'
  )
})

test('a backup dir overlapping the library is refused', async () => {
  const fixture = newFixture()
  assert.ok(validateBackupDirectory(path.join(fixture.libraryDir, 'backups'), fixture.libraryDir))
  assert.ok(validateBackupDirectory(fixture.libraryDir, fixture.libraryDir))
  assert.equal(validateBackupDirectory(fixture.backupDir, fixture.libraryDir), null)
  await assert.rejects(
    createBackupSnapshot({
      ...fixture,
      backupDir: path.join(fixture.libraryDir, 'nested'),
      trigger: 'manual'
    }),
    /overlaps the library directory/
  )
})

test('a missing state file (pre-registration) does not fail the backup', async () => {
  const fixture = newFixture()
  rmSync(fixture.stateFilePath)
  const nowMs = Date.now()
  writeSettledFile(fixture.libraryDir, 'file.3mf', 'bytes', nowMs)

  const { snapshot } = await createBackupSnapshot({ ...fixture, trigger: 'manual', now: () => nowMs })
  assert.ok(!existsSync(path.join(fixture.backupDir, snapshot.name, 'bridge-state.json')))
  assert.equal(snapshot.fileCount, 1)
})

test('an empty library still snapshots the identity file', async () => {
  const fixture = newFixture()
  const nowMs = Date.now()
  const { snapshot } = await createBackupSnapshot({ ...fixture, trigger: 'manual', now: () => nowMs })
  assert.equal(snapshot.fileCount, 0)
  assert.ok(existsSync(path.join(fixture.backupDir, snapshot.name, 'bridge-state.json')))
})
