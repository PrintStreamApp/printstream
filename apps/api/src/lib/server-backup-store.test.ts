import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  pruneServerBackups,
  readSnapshotManifests,
  restoreBlockedReason,
  validateServerBackupsDir,
  type ServerBackupManifest
} from './server-backup-store.js'
import { libpqCompatibleUrl } from './server-backup-tools.js'

const DAY_MS = 24 * 60 * 60 * 1000

function makeManifest(overrides: Partial<ServerBackupManifest>): ServerBackupManifest {
  return {
    version: 1,
    kind: 'server-backup',
    createdAt: new Date().toISOString(),
    trigger: 'scheduled',
    appRevision: 'abc123',
    postgresVersion: '16.4',
    appliedMigrations: [],
    dbDumpBytes: 10,
    dataFileCount: 0,
    dataTotalBytes: 0,
    copiedBytes: 10,
    skippedInFlightCount: 0,
    durationMs: 5,
    files: {},
    ...overrides
  }
}

function writeSnapshot(backupsDir: string, createdAtMs: number, trigger: ServerBackupManifest['trigger']): string {
  const createdAt = new Date(createdAtMs).toISOString()
  const name = `server-backup-${createdAt.replace(/[:.]/g, '-')}`
  const dir = path.join(backupsDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(makeManifest({ createdAt, trigger })))
  return name
}

test('libpqCompatibleUrl strips Prisma-only params and keeps libpq ones', () => {
  // pg_dump rejects Prisma's ?schema= outright (seen live on the dev stack).
  const cleaned = libpqCompatibleUrl('postgresql://u:p@db:5432/printstream?schema=public&connection_limit=5&sslmode=require')
  assert.ok(!cleaned.includes('schema='))
  assert.ok(!cleaned.includes('connection_limit='))
  assert.ok(cleaned.includes('sslmode=require'))
})

test('restoreBlockedReason refuses a backup carrying unknown migrations', () => {
  const manifest = makeManifest({ appliedMigrations: ['001_init', '999_future'] })
  const reason = restoreBlockedReason(manifest, new Set(['001_init']), '16.4')
  assert.match(reason ?? '', /newer version of the app/)
})

test('restoreBlockedReason refuses a dump from a newer Postgres major', () => {
  const manifest = makeManifest({ postgresVersion: '18.1', appliedMigrations: ['001_init'] })
  const reason = restoreBlockedReason(manifest, new Set(['001_init']), '16.4')
  assert.match(reason ?? '', /PostgreSQL 18/)
})

test('restoreBlockedReason allows an older backup into a newer install', () => {
  const manifest = makeManifest({ postgresVersion: '16.1', appliedMigrations: ['001_init'] })
  assert.equal(restoreBlockedReason(manifest, new Set(['001_init', '002_next']), '18.1'), null)
})

test('restoreBlockedReason tolerates an unknown Postgres version', () => {
  const manifest = makeManifest({ postgresVersion: null, appliedMigrations: [] })
  assert.equal(restoreBlockedReason(manifest, new Set(), null), null)
})

test('validateServerBackupsDir refuses a dir inside a snapshotted tree', () => {
  const dataDir = '/data'
  assert.ok(validateServerBackupsDir('/data/library/backups', dataDir))
  assert.equal(validateServerBackupsDir('/backups', dataDir), null)
  // A sibling of the snapshotted trees (the compose/native default) is fine.
  assert.equal(validateServerBackupsDir('/data/backups', dataDir), null)
})

test('pruneServerBackups ages scheduled snapshots but never manual or pre-restore ones', async () => {
  const backupsDir = mkdtempSync(path.join(tmpdir(), 'server-backups-'))
  try {
    const now = Date.now()
    // Two scheduled snapshots in the same old weekly bucket: the newer is pruned.
    const oldScheduledA = writeSnapshot(backupsDir, now - 13 * DAY_MS, 'scheduled')
    const oldScheduledB = writeSnapshot(backupsDir, now - 12 * DAY_MS, 'scheduled')
    const oldManual = writeSnapshot(backupsDir, now - 13 * DAY_MS + 1000, 'manual')
    const oldPreRestore = writeSnapshot(backupsDir, now - 12 * DAY_MS + 1000, 'pre-restore')
    // A crashed run's staging dir is swept regardless.
    mkdirSync(path.join(backupsDir, 'server-backup-stale.partial'))

    const pruned = await pruneServerBackups(backupsDir, now)

    assert.equal(pruned, 1)
    assert.ok(existsSync(path.join(backupsDir, oldScheduledA)), 'oldest scheduled snapshot in the bucket survives')
    assert.ok(!existsSync(path.join(backupsDir, oldScheduledB)))
    assert.ok(existsSync(path.join(backupsDir, oldManual)), 'manual snapshots are keep-until-deleted')
    assert.ok(existsSync(path.join(backupsDir, oldPreRestore)), 'pre-restore snapshots are keep-until-deleted')
    assert.ok(!readdirSync(backupsDir).some((name) => name.endsWith('.partial')))
  } finally {
    rmSync(backupsDir, { recursive: true, force: true })
  }
})

test('readSnapshotManifests orders newest first and skips junk', async () => {
  const backupsDir = mkdtempSync(path.join(tmpdir(), 'server-backups-'))
  try {
    const now = Date.now()
    writeSnapshot(backupsDir, now - DAY_MS, 'scheduled')
    const newest = writeSnapshot(backupsDir, now, 'manual')
    mkdirSync(path.join(backupsDir, 'server-backup-junk'))
    mkdirSync(path.join(backupsDir, 'pre-update-abc'))

    const manifests = await readSnapshotManifests(backupsDir)
    assert.equal(manifests.length, 2)
    assert.equal(manifests[0]?.name, newest)
  } finally {
    rmSync(backupsDir, { recursive: true, force: true })
  }
})
