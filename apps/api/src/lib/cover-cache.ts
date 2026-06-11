/**
 * Current-print cover cache.
 *
 * Stores extracted plate-cover PNGs on disk so repeated requests for the
 * same printer/job do not need to re-download a 3MF over slow printer FTPS.
 * Misses are cached briefly to avoid retry loops when a cover is unavailable.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from './env.js'

const COVER_CACHE_DIR = path.resolve(path.dirname(env.LIBRARY_DIR), 'cover-cache')
const COVER_ALIAS_DIR = path.join(COVER_CACHE_DIR, 'aliases')
const COVER_TTL_MS = 24 * 60 * 60 * 1000
const ALIAS_TTL_MS = COVER_TTL_MS
const NEGATIVE_TTL_MS = 60 * 1000
const MAX_MEMORY_COVERS = 32
const MAX_MEMORY_COVER_BYTES = 32 * 1024 * 1024
const MAX_MEMORY_ALIASES = 512
const MAX_NEGATIVE_CACHE_ENTRIES = 512

interface MemoryCoverEntry {
  png: Buffer
  fetchedAt: number
}

interface CoverAliasEntry {
  cacheKey: string
  mappedAt: number
}

const memoryCache = new Map<string, MemoryCoverEntry>()
const aliasCache = new Map<string, CoverAliasEntry>()
const negativeCache = new Map<string, number>()
const inflight = new Map<string, Promise<Buffer>>()
let memoryCacheBytes = 0

export async function getCachedCoverByAliases(aliases: string[]): Promise<Buffer | null> {
  for (const alias of aliases) {
    const cacheKey = await getAliasedCacheKey(alias)
    if (!cacheKey) continue

    const cached = await getCachedCover(cacheKey)
    if (cached) return cached

    aliasCache.delete(alias)
    await deleteAliasedCacheKey(alias)
  }

  return null
}

export async function getCachedCover(cacheKey: string): Promise<Buffer | null> {
  if (isNegativeCached(cacheKey)) return null

  const cached = memoryCache.get(cacheKey)
  if (cached) {
    if (Date.now() - cached.fetchedAt < COVER_TTL_MS) return cached.png
    deleteMemoryCover(cacheKey)
  }

  const filePath = coverPath(cacheKey)
  try {
    const info = await stat(filePath)
    if (Date.now() - info.mtimeMs > COVER_TTL_MS) {
      await rm(filePath, { force: true }).catch(() => undefined)
      return null
    }
    const png = await readFile(filePath)
    rememberMemoryCover(cacheKey, png, info.mtimeMs)
    return png
  } catch {
    return null
  }
}

export async function setCachedCover(cacheKey: string, png: Buffer): Promise<void> {
  negativeCache.delete(cacheKey)
  rememberMemoryCover(cacheKey, png, Date.now())
  await mkdir(COVER_CACHE_DIR, { recursive: true })
  await writeFile(coverPath(cacheKey), png)
}

export async function rememberCoverAliases(cacheKey: string, aliases: string[]): Promise<void> {
  pruneAliasCache()
  const mappedAt = Date.now()
  await mkdir(COVER_ALIAS_DIR, { recursive: true })
  for (const alias of aliases) {
    rememberAlias(alias, { cacheKey, mappedAt })
    await writeFile(aliasPath(alias), cacheKey, 'utf8')
  }
}

export function markCoverMiss(cacheKey: string): void {
  pruneNegativeCache()
  negativeCache.set(cacheKey, Date.now())
  trimNegativeCache()
}

export function isNegativeCached(cacheKey: string): boolean {
  const cachedAt = negativeCache.get(cacheKey)
  if (cachedAt == null) return false
  if (Date.now() - cachedAt < NEGATIVE_TTL_MS) return true
  negativeCache.delete(cacheKey)
  return false
}

export function getInflightCover(cacheKey: string): Promise<Buffer> | null {
  return inflight.get(cacheKey) ?? null
}

export function setInflightCover(cacheKey: string, promise: Promise<Buffer>): void {
  inflight.set(cacheKey, promise)
  const cleanup = () => {
    if (inflight.get(cacheKey) === promise) inflight.delete(cacheKey)
  }
  promise.then(cleanup, cleanup)
}

async function getAliasedCacheKey(alias: string): Promise<string | null> {
  const entry = aliasCache.get(alias)
  if (entry) {
    if (Date.now() - entry.mappedAt < ALIAS_TTL_MS) return entry.cacheKey
    aliasCache.delete(alias)
  }

  const filePath = aliasPath(alias)
  try {
    const info = await stat(filePath)
    if (Date.now() - info.mtimeMs > ALIAS_TTL_MS) {
      await rm(filePath, { force: true })
      return null
    }
    const cacheKey = (await readFile(filePath, 'utf8')).trim()
    if (!cacheKey) {
      await rm(filePath, { force: true })
      return null
    }
    rememberAlias(alias, { cacheKey, mappedAt: info.mtimeMs })
    return cacheKey
  } catch {
    return null
  }
}

export async function pruneCoverCache(): Promise<{
  removedCoverFiles: number
  removedAliasFiles: number
  removedMemoryEntries: number
  removedNegativeEntries: number
}> {
  const now = Date.now()
  const removedMemoryEntries = pruneExpiredMemoryCache(now)
  const removedNegativeEntries = pruneNegativeCache(now)
  const removedAliasEntries = pruneAliasCache(now)
  const removedCoverFiles = await pruneCacheDirectory(COVER_CACHE_DIR, COVER_TTL_MS, '.png')
  const removedAliasFiles = await pruneCacheDirectory(COVER_ALIAS_DIR, ALIAS_TTL_MS, '.key')
  return {
    removedCoverFiles,
    removedAliasFiles: removedAliasFiles + removedAliasEntries,
    removedMemoryEntries,
    removedNegativeEntries
  }
}

function rememberMemoryCover(cacheKey: string, png: Buffer, fetchedAt: number): void {
  const existing = memoryCache.get(cacheKey)
  if (existing) {
    memoryCacheBytes -= existing.png.byteLength
    memoryCache.delete(cacheKey)
  }
  memoryCache.set(cacheKey, { png, fetchedAt })
  memoryCacheBytes += png.byteLength
  trimMemoryCache()
}

function deleteMemoryCover(cacheKey: string): boolean {
  const existing = memoryCache.get(cacheKey)
  if (!existing) return false
  memoryCache.delete(cacheKey)
  memoryCacheBytes = Math.max(0, memoryCacheBytes - existing.png.byteLength)
  return true
}

function trimMemoryCache(now = Date.now()): void {
  pruneExpiredMemoryCache(now)
  while (memoryCache.size > MAX_MEMORY_COVERS || memoryCacheBytes > MAX_MEMORY_COVER_BYTES) {
    const oldestKey = memoryCache.keys().next().value
    if (!oldestKey) break
    deleteMemoryCover(oldestKey)
  }
}

function pruneExpiredMemoryCache(now = Date.now()): number {
  let removed = 0
  for (const [cacheKey, entry] of memoryCache.entries()) {
    if (now - entry.fetchedAt <= COVER_TTL_MS) continue
    if (deleteMemoryCover(cacheKey)) removed += 1
  }
  return removed
}

function rememberAlias(alias: string, entry: CoverAliasEntry): void {
  if (aliasCache.has(alias)) aliasCache.delete(alias)
  aliasCache.set(alias, entry)
  while (aliasCache.size > MAX_MEMORY_ALIASES) {
    const oldestKey = aliasCache.keys().next().value
    if (!oldestKey) break
    aliasCache.delete(oldestKey)
  }
}

function pruneAliasCache(now = Date.now()): number {
  let removed = 0
  for (const [alias, entry] of aliasCache.entries()) {
    if (now - entry.mappedAt <= ALIAS_TTL_MS) continue
    aliasCache.delete(alias)
    removed += 1
  }
  return removed
}

function pruneNegativeCache(now = Date.now()): number {
  let removed = 0
  for (const [cacheKey, cachedAt] of negativeCache.entries()) {
    if (now - cachedAt < NEGATIVE_TTL_MS) continue
    negativeCache.delete(cacheKey)
    removed += 1
  }
  return removed
}

function trimNegativeCache(): void {
  while (negativeCache.size > MAX_NEGATIVE_CACHE_ENTRIES) {
    const oldestKey = negativeCache.keys().next().value
    if (!oldestKey) break
    negativeCache.delete(oldestKey)
  }
}

async function pruneCacheDirectory(dirPath: string, maxAgeMs: number, expectedSuffix: string): Promise<number> {
  let names: string[] = []
  try {
    names = await readdir(dirPath)
  } catch {
    return 0
  }

  let removed = 0
  const now = Date.now()
  for (const name of names) {
    if (!name.endsWith(expectedSuffix)) continue
    const filePath = path.join(dirPath, name)
    try {
      const info = await stat(filePath)
      if (now - info.mtimeMs <= maxAgeMs) continue
      await rm(filePath, { force: true })
      removed += 1
    } catch {
      // Ignore races with concurrent readers/writers and continue pruning.
    }
  }

  return removed
}

function coverPath(cacheKey: string): string {
  const digest = createHash('sha256').update(cacheKey).digest('hex')
  return path.join(COVER_CACHE_DIR, `${digest}.png`)
}

function aliasPath(alias: string): string {
  const digest = createHash('sha256').update(alias).digest('hex')
  return path.join(COVER_ALIAS_DIR, `${digest}.key`)
}

async function deleteAliasedCacheKey(alias: string): Promise<void> {
  await rm(aliasPath(alias), { force: true }).catch(() => undefined)
}
