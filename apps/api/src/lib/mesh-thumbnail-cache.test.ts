import assert from 'node:assert/strict'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { readdir, rm, utimes } from 'node:fs/promises'
import { libraryDir } from './library-paths.js'
import {
  isLikelyPng,
  pruneMeshThumbnailCache,
  readMeshThumbnailCache,
  writeMeshThumbnailCache
} from './mesh-thumbnail-cache.js'

const cacheRoot = path.join(libraryDir, '_mesh-thumbnail-cache')

function png(...extra: number[]): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...extra])
}

async function listCachedFiles(): Promise<string[]> {
  const versions = await readdir(cacheRoot, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const version of versions) {
    if (!version.isDirectory()) continue
    const dir = path.join(cacheRoot, version.name)
    for (const entry of await readdir(dir)) files.push(path.join(dir, entry))
  }
  return files
}

afterEach(async () => {
  await rm(cacheRoot, { recursive: true, force: true }).catch(() => undefined)
})

test('isLikelyPng accepts the PNG signature and rejects other bytes', () => {
  assert.equal(isLikelyPng(png(1, 2, 3)), true)
  assert.equal(isLikelyPng(Buffer.from('not a png at all')), false)
  assert.equal(isLikelyPng(Buffer.alloc(0)), false)
  // A buffer shorter than the 8-byte signature is not a PNG.
  assert.equal(isLikelyPng(Buffer.from([0x89, 0x50, 0x4e])), false)
})

test('write then read round-trips the stored PNG for a file', async () => {
  const file = { ownerBridgeId: 'bridge-a', storedPath: 'model-abc.stl' }
  assert.equal(await readMeshThumbnailCache(file), null)

  const bytes = png(10, 20, 30)
  await writeMeshThumbnailCache(file, bytes)

  const read = await readMeshThumbnailCache(file)
  assert.ok(read)
  assert.deepEqual(read, bytes)
})

test('a new version (new storedPath) misses the cache so it regenerates', async () => {
  const v1 = { ownerBridgeId: 'bridge-a', storedPath: 'model-v1.stl' }
  const v2 = { ownerBridgeId: 'bridge-a', storedPath: 'model-v2.stl' }
  await writeMeshThumbnailCache(v1, png(1))

  // The new version has its own collision-free storedPath, so it does not see the
  // old render — exactly the "regenerate when content changes" behaviour we want.
  assert.equal(await readMeshThumbnailCache(v2), null)
  assert.ok(await readMeshThumbnailCache(v1))
})

test('the cache key includes the owning bridge so local and bridge files do not collide', async () => {
  const local = { ownerBridgeId: null, storedPath: 'same-name.stl' }
  const bridge = { ownerBridgeId: 'bridge-a', storedPath: 'same-name.stl' }
  await writeMeshThumbnailCache(local, png(0xaa))
  await writeMeshThumbnailCache(bridge, png(0xbb))

  assert.deepEqual(await readMeshThumbnailCache(local), png(0xaa))
  assert.deepEqual(await readMeshThumbnailCache(bridge), png(0xbb))
})

test('pruneMeshThumbnailCache removes stale renders and keeps fresh ones', async () => {
  const stale = { ownerBridgeId: 'bridge-a', storedPath: 'stale.stl' }
  const fresh = { ownerBridgeId: 'bridge-a', storedPath: 'fresh.stl' }
  await writeMeshThumbnailCache(stale, png(1))
  await writeMeshThumbnailCache(fresh, png(2))

  // Age every cached file past the prune window, then rewrite the fresh entry so only
  // its mtime returns to "now".
  const aged = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
  for (const file of await listCachedFiles()) {
    await utimes(file, aged, aged)
  }
  await writeMeshThumbnailCache(fresh, png(2))

  const result = await pruneMeshThumbnailCache(7 * 24 * 60 * 60 * 1000)
  assert.equal(result.removedFiles, 1)
  assert.equal(await readMeshThumbnailCache(stale), null)
  assert.ok(await readMeshThumbnailCache(fresh))
})
