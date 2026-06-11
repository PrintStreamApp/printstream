process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { after, beforeEach, test } from 'node:test'

const testRoot = mkdtempSync(path.join(tmpdir(), 'bambu-cover-cache-test-'))
process.env.LIBRARY_DIR = path.join(testRoot, 'library')

const { getCachedCover, pruneCoverCache, rememberCoverAliases } = await import('./cover-cache.js')

const coverCacheDir = path.join(testRoot, 'cover-cache')
const coverAliasDir = path.join(coverCacheDir, 'aliases')

after(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  await rm(testRoot, { recursive: true, force: true })
  await mkdir(process.env.LIBRARY_DIR!, { recursive: true })
})

test('getCachedCover removes stale cover files on access', async () => {
  const cacheKey = 'printer-1\u0000job-1'
  const digest = createHash('sha256').update(cacheKey).digest('hex')
  const filePath = path.join(coverCacheDir, `${digest}.png`)
  await mkdir(coverCacheDir, { recursive: true })
  await writeFile(filePath, Buffer.from('png-data'))

  const staleDate = new Date(Date.now() - (25 * 60 * 60 * 1000))
  await utimes(filePath, staleDate, staleDate)

  const cached = await getCachedCover(cacheKey)
  await assert.rejects(stat(filePath), /ENOENT/)
  assert.equal(cached, null)
})

test('pruneCoverCache removes stale cover and alias files', async () => {
  const cacheKey = 'printer-2\u0000job-2'
  const alias = 'printer-2\u0000alias'
  const digest = createHash('sha256').update(cacheKey).digest('hex')
  const aliasDigest = createHash('sha256').update(alias).digest('hex')
  const coverPath = path.join(coverCacheDir, `${digest}.png`)
  const aliasPath = path.join(coverAliasDir, `${aliasDigest}.key`)

  await mkdir(coverAliasDir, { recursive: true })
  await writeFile(coverPath, Buffer.from('png-data'))
  await rememberCoverAliases(cacheKey, [alias])

  const staleDate = new Date(Date.now() - (25 * 60 * 60 * 1000))
  await utimes(coverPath, staleDate, staleDate)
  await utimes(aliasPath, staleDate, staleDate)

  const result = await pruneCoverCache()

  assert.equal(result.removedCoverFiles, 1)
  assert.equal(result.removedAliasFiles, 1)
  await assert.rejects(readFile(coverPath), /ENOENT/)
  await assert.rejects(readFile(aliasPath), /ENOENT/)
})