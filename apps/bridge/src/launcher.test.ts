import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  cleanupConfirmedBridgeReleases,
  confirmActiveBridgeReleaseHealthy,
  isActiveBridgeReleasePendingHealthCheck,
  resolveActiveBridgeEntrypoint,
  restorePreviousBridgeRelease
} from './launcher.js'

test('resolveActiveBridgeEntrypoint returns null when no active release is set', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-releases-'))
  try {
    assert.equal(await resolveActiveBridgeEntrypoint(dir), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('resolveActiveBridgeEntrypoint resolves a safe active release entrypoint', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-releases-'))
  try {
    const releaseDir = path.join(dir, '0.2.0')
    const entrypoint = path.join(releaseDir, 'dist/index.js')
    await mkdir(path.dirname(entrypoint), { recursive: true })
    await writeFile(entrypoint, 'console.log("ok")\n', 'utf8')
    await writeFile(path.join(dir, 'current.json'), JSON.stringify({
      releasePath: '0.2.0',
      entrypoint: 'dist/index.js'
    }), 'utf8')

    assert.equal(await resolveActiveBridgeEntrypoint(dir), entrypoint)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('resolveActiveBridgeEntrypoint rejects release pointers that escape the releases directory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-releases-'))
  try {
    await writeFile(path.join(dir, 'current.json'), JSON.stringify({
      releasePath: '..',
      entrypoint: 'outside.js'
    }), 'utf8')

    await assert.rejects(() => resolveActiveBridgeEntrypoint(dir), /cannot escape/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('restorePreviousBridgeRelease replaces current pointer when rollback metadata exists', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-releases-'))
  try {
    await writeFile(path.join(dir, 'current.json'), JSON.stringify({ releasePath: 'bad', entrypoint: 'dist/index.js' }), 'utf8')
    await writeFile(path.join(dir, 'previous.json'), JSON.stringify({ releasePath: 'good', entrypoint: 'dist/index.js' }), 'utf8')

    assert.equal(await restorePreviousBridgeRelease(dir), true)
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'current.json'), 'utf8')), {
      releasePath: 'good',
      entrypoint: 'dist/index.js'
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('confirmActiveBridgeReleaseHealthy clears pending health check for the active version', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-releases-'))
  try {
    await writeFile(path.join(dir, 'current.json'), JSON.stringify({
      releasePath: '0.2.0',
      entrypoint: 'dist/index.js',
      activatedAt: '2026-05-20T00:00:00.000Z',
      pendingHealthCheck: true
    }), 'utf8')

    assert.equal(await isActiveBridgeReleasePendingHealthCheck(dir), true)
    assert.equal(await confirmActiveBridgeReleaseHealthy(dir, '0.2.0'), true)
    const pointer = JSON.parse(await readFile(path.join(dir, 'current.json'), 'utf8')) as { pendingHealthCheck: boolean; confirmedAt?: string }
    assert.equal(pointer.pendingHealthCheck, false)
    assert.equal(typeof pointer.confirmedAt, 'string')
    assert.equal(await isActiveBridgeReleasePendingHealthCheck(dir), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('confirmActiveBridgeReleaseHealthy ignores non-active versions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-releases-'))
  try {
    await writeFile(path.join(dir, 'current.json'), JSON.stringify({
      releasePath: '0.2.0',
      entrypoint: 'dist/index.js',
      pendingHealthCheck: true
    }), 'utf8')

    assert.equal(await confirmActiveBridgeReleaseHealthy(dir, '0.1.0'), false)
    assert.equal(await isActiveBridgeReleasePendingHealthCheck(dir), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cleanupConfirmedBridgeReleases keeps old releases during pending health check', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-releases-'))
  try {
    await mkdir(path.join(dir, '0.1.0'), { recursive: true })
    await mkdir(path.join(dir, '0.2.0'), { recursive: true })
    await writeFile(path.join(dir, 'current.json'), JSON.stringify({
      releasePath: '0.2.0',
      entrypoint: 'dist/index.js',
      pendingHealthCheck: true,
      confirmedAt: '2026-05-01T00:00:00.000Z'
    }), 'utf8')

    assert.deepEqual(await cleanupConfirmedBridgeReleases({
      releasesDir: dir,
      retentionMs: 0,
      now: new Date('2026-05-20T00:00:00.000Z')
    }), [])
    assert.equal(await stat(path.join(dir, '0.1.0')).then(() => true, () => false), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cleanupConfirmedBridgeReleases removes old releases after retention window', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-releases-'))
  try {
    await mkdir(path.join(dir, '0.1.0'), { recursive: true })
    await mkdir(path.join(dir, '0.2.0'), { recursive: true })
    await mkdir(path.join(dir, '.staging', '0.3.0'), { recursive: true })
    await writeFile(path.join(dir, 'previous.json'), JSON.stringify({ releasePath: '0.1.0', entrypoint: 'dist/index.js' }), 'utf8')
    await writeFile(path.join(dir, 'current.json'), JSON.stringify({
      releasePath: '0.2.0',
      entrypoint: 'dist/index.js',
      pendingHealthCheck: false,
      confirmedAt: '2026-05-01T00:00:00.000Z'
    }), 'utf8')

    assert.deepEqual(await cleanupConfirmedBridgeReleases({
      releasesDir: dir,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      now: new Date('2026-05-20T00:00:00.000Z')
    }), ['0.1.0'])
    await assert.rejects(() => readFile(path.join(dir, 'previous.json')), /ENOENT/)
    assert.equal(await stat(path.join(dir, '0.1.0')).then(() => true, () => false), false)
    assert.equal(await stat(path.join(dir, '0.2.0')).then(() => true, () => false), true)
    assert.equal(await stat(path.join(dir, '.staging', '0.3.0')).then(() => true, () => false), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})