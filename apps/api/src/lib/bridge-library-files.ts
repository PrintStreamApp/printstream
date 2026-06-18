/**
 * Bridge-owned library file helpers.
 */
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import {
  bridgeLibraryReadChunkResultSchema,
  bridgeLibraryStatResultSchema,
  bridgeLibraryThreeMfIndexSchema,
  bridgeLibraryInspect3mfResultSchema,
  bridgeLibraryReadThumbnailResultSchema,
  createAbortError,
  type BridgeLibraryThreeMfIndex
} from '@printstream/shared'
import { THREE_MF_INDEX_PARSER_VERSION } from '@printstream/shared/three-mf'
import { bridgeSessionManager } from './bridge-session-manager.js'
import { bridgeUnavailableMessage } from './managed-bridge.js'
import { libraryDir, locateLibraryFile } from './library-paths.js'
import { prisma } from './prisma.js'
import { readEntry, readPlateIndex } from './three-mf.js'

const bridgeLibraryCacheDir = path.join(libraryDir, '_bridge-cache')
const bridgeLibraryDerivedCacheDir = path.join(libraryDir, '_bridge-derived-cache')
const BRIDGE_LIBRARY_TRANSFER_CHUNK_BYTES = 4 * 1024 * 1024
const BRIDGE_LIBRARY_DERIVED_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000
/**
 * Version for the on-disk derived 3MF index cache. Derived from the shared parser version
 * ({@link THREE_MF_INDEX_PARSER_VERSION}) so the index shape and the cache invalidate together —
 * bumping the shared parser version drops stale derived entries automatically.
 */
const BRIDGE_LIBRARY_DERIVED_CACHE_VERSION = THREE_MF_INDEX_PARSER_VERSION

type CachedBridgeThreeMfIndex = {
  mtimeMs: number
  size: number
  index: BridgeLibraryThreeMfIndex
}

const bridgeThreeMfIndexCache = new Map<string, CachedBridgeThreeMfIndex>()

export async function storeBridgeLibraryFile(
  bridgeId: string,
  storedPath: string,
  sourcePath: string,
  options: { onProgress?: (transferredBytes: number) => Promise<void> | void } = {}
): Promise<void> {
  await clearBridgeLibraryLocalCache(bridgeId, storedPath)
  await beginBridgeLibraryWrite(bridgeId, storedPath)
  const stream = createReadStream(sourcePath, { highWaterMark: BRIDGE_LIBRARY_TRANSFER_CHUNK_BYTES })
  let transferredBytes = 0
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      await appendBridgeLibraryChunk(
        bridgeId,
        storedPath,
        buffer
      )
      transferredBytes += buffer.byteLength
      await options.onProgress?.(transferredBytes)
    }
  } catch (error) {
    stream.destroy()
    await deleteBridgeLibraryFile(bridgeId, storedPath).catch(() => undefined)
    throw error
  }
}

export async function storeBridgeLibraryBuffer(bridgeId: string, storedPath: string, fileBuffer: Buffer): Promise<void> {
  await clearBridgeLibraryLocalCache(bridgeId, storedPath)
  await beginBridgeLibraryWrite(bridgeId, storedPath)
  try {
    for (let offset = 0; offset < fileBuffer.byteLength; offset += BRIDGE_LIBRARY_TRANSFER_CHUNK_BYTES) {
      await appendBridgeLibraryChunk(
        bridgeId,
        storedPath,
        fileBuffer.subarray(offset, offset + BRIDGE_LIBRARY_TRANSFER_CHUNK_BYTES)
      )
    }
  } catch (error) {
    await deleteBridgeLibraryFile(bridgeId, storedPath).catch(() => undefined)
    throw error
  }
}

export async function readBridgeLibraryFile(bridgeId: string, storedPath: string): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let offset = 0

  for (;;) {
    const result = await requestBridgeLibraryChunk(bridgeId, storedPath, offset)
    if (result.bufferBase64 == null) {
      return null
    }
    const chunk = Buffer.from(result.bufferBase64, 'base64')
    if (chunk.byteLength > 0) {
      chunks.push(chunk)
      offset += chunk.byteLength
    }
    if (result.eof) {
      return Buffer.concat(chunks)
    }
    if (chunk.byteLength === 0) {
      throw new Error('Bridge library read returned an empty chunk before EOF')
    }
  }
}

export async function inspectBridgeLibraryThreeMf(input: {
  ownerBridgeId?: string | null
  storedPath: string
}, signal?: AbortSignal): Promise<BridgeLibraryThreeMfIndex> {
  const bridgeId = requireLibraryOwnerBridgeId(input.ownerBridgeId)
  try {
    const cachedIndex = await readCachedBridgeLibraryThreeMfIndex(bridgeId, input.storedPath, signal)
    if (cachedIndex) return cachedIndex
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error
  }
  const derivedIndex = await readCachedBridgeLibraryDerivedIndex(bridgeId, input.storedPath)
  if (derivedIndex) return derivedIndex

  const result = bridgeLibraryInspect3mfResultSchema.parse(await requestBridgeLibraryRpc(
    bridgeId,
    'library.inspect3mf',
    { storedPath: input.storedPath },
    signal
  ))
  if (shouldFallbackToLocalThreeMfParse(result.index)) {
    const localPath = await ensureBridgeLibraryLocalCopy({
      bridgeId,
      storedPath: input.storedPath
    })
    const index = await readPlateIndex(localPath, signal)
    await writeCachedBridgeLibraryDerivedIndex(bridgeId, input.storedPath, index)
    return index
  }
  await writeCachedBridgeLibraryDerivedIndex(bridgeId, input.storedPath, result.index)
  return result.index
}

function shouldFallbackToLocalThreeMfParse(index: BridgeLibraryThreeMfIndex): boolean {
  return index.projectFilaments.length > 0 && (
    index.processProfileName == null
    || index.printerProfileName == null
    || index.plates.every((plate) => plate.filaments.length === 0)
  )
}

export async function statBridgeLibraryFile(input: {
  ownerBridgeId?: string | null
  storedPath: string
}, signal?: AbortSignal): Promise<{ sizeBytes: number; contentSha256: string }> {
  return bridgeLibraryStatResultSchema.parse(await requestBridgeLibraryRpc(
    requireLibraryOwnerBridgeId(input.ownerBridgeId),
    'library.stat',
    { storedPath: input.storedPath },
    signal
  ))
}

export async function copyBridgeLibraryFile(input: {
  ownerBridgeId?: string | null
  sourceStoredPath: string
  targetStoredPath: string
}, signal?: AbortSignal): Promise<void> {
  await requestBridgeLibraryRpc(
    requireLibraryOwnerBridgeId(input.ownerBridgeId),
    'library.copy',
    {
      sourceStoredPath: input.sourceStoredPath,
      targetStoredPath: input.targetStoredPath
    },
    signal
  )
}

export async function readBridgeLibraryThumbnail(input: {
  ownerBridgeId?: string | null
  storedPath: string
}, plateIndex: number | null, signal?: AbortSignal): Promise<Buffer | null> {
  const bridgeId = requireLibraryOwnerBridgeId(input.ownerBridgeId)
  const cachedThumbnail = await readCachedBridgeLibraryThumbnail(bridgeId, input.storedPath, plateIndex)
  if (cachedThumbnail) return cachedThumbnail

  try {
    const result = bridgeLibraryReadThumbnailResultSchema.parse(await requestBridgeLibraryRpc(
      bridgeId,
      'library.readThumbnail',
      {
        storedPath: input.storedPath,
        plateIndex
      },
      signal
    ))
    if (result.pngBase64) {
      const png = Buffer.from(result.pngBase64, 'base64')
      await writeCachedBridgeLibraryThumbnail(bridgeId, input.storedPath, plateIndex, png)
      return png
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error
  }

  try {
    const localPath = await ensureBridgeLibraryLocalCopy({
      bridgeId,
      storedPath: input.storedPath
    })
    let entryPath = plateIndex != null ? `Metadata/plate_${plateIndex}.png` : 'Metadata/plate_1.png'
    try {
      const index = await readPlateIndex(localPath, signal)
      const plate = plateIndex == null
        ? index.plates[0]
        : index.plates.find((entry) => entry.index === plateIndex) ?? index.plates[0]
      entryPath = plate?.thumbnailFile ?? entryPath
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error
    }
    const png = await readEntry(localPath, entryPath, signal)
    await writeCachedBridgeLibraryThumbnail(bridgeId, input.storedPath, plateIndex, png)
    return png
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error
    console.warn(`[bridge-library] thumbnail read failed for ${input.storedPath}`, (error as Error).message)
    return null
  }
}

export async function deleteBridgeLibraryFile(bridgeId: string, storedPath: string): Promise<void> {
  await requestBridgeLibraryRpc(bridgeId, 'library.delete', { storedPath })
  await clearBridgeLibraryLocalCache(bridgeId, storedPath)
}

function requireLibraryOwnerBridgeId(ownerBridgeId: string | null | undefined): string {
  if (!ownerBridgeId) {
    throw new Error('Bridge-backed library file required')
  }
  return ownerBridgeId
}

export async function resolveLibraryFileToLocalPath(input: {
  ownerBridgeId?: string | null
  storedPath: string
}): Promise<string> {
  if (!input.ownerBridgeId) {
    return await locateLibraryFile(input.storedPath)
  }
  return await ensureBridgeLibraryLocalCopy({
    bridgeId: requireLibraryOwnerBridgeId(input.ownerBridgeId),
    storedPath: input.storedPath
  })
}

export async function deleteLibraryFileBytes(input: {
  ownerBridgeId?: string | null
  storedPath: string
}): Promise<void> {
  await deleteBridgeLibraryFile(requireLibraryOwnerBridgeId(input.ownerBridgeId), input.storedPath)
}

export async function pruneBridgeLibraryDerivedCache(maxAgeMs = BRIDGE_LIBRARY_DERIVED_CACHE_TTL_MS): Promise<{
  removedFiles: number
  removedDirs: number
}> {
  return await pruneDerivedCacheDirectory(bridgeLibraryDerivedCacheDir, maxAgeMs)
}

export async function ensureBridgeLibraryLocalCopy(input: {
  bridgeId: string
  storedPath: string
}): Promise<string> {
  const targetPath = resolveBridgeLibraryCachePath(input.bridgeId, input.storedPath)
  if (await isBridgeLibraryLocalCopyComplete(input.bridgeId, input.storedPath, targetPath)) {
    return targetPath
  }
  await rm(targetPath, { force: true }).catch(() => undefined)
  await copyBridgeLibraryFileToLocalCache(input.bridgeId, input.storedPath, targetPath)
  return targetPath
}

async function isBridgeLibraryLocalCopyComplete(bridgeId: string, storedPath: string, targetPath: string): Promise<boolean> {
  let info
  try {
    info = await stat(targetPath)
  } catch {
    return false
  }

  const result = await requestBridgeLibraryChunk(bridgeId, storedPath, info.size)
  if (result.bufferBase64 == null) return false
  const chunk = Buffer.from(result.bufferBase64, 'base64')
  return result.eof && chunk.byteLength === 0
}

/**
 * Coalesce concurrent replica builds for the same (libraryFileId, targetBridgeId).
 * The replica's stored path is deterministic ({@link buildReplicaStoredPath}), so two
 * simultaneous dispatches of the same file to the same bridge would both truncate and
 * append to the SAME path, interleaving into a corrupt file and racing the `ready`
 * upsert. Deduping onto one in-flight transfer makes the second caller await the first.
 */
const inflightReplicaBuilds = new Map<string, Promise<string>>()

export async function ensureLibraryFileReplica(input: {
  tenantId: string
  libraryFileId: string
  fileName: string
  sourceBridgeId: string | null
  sourceStoredPath: string
  sizeBytes: number
  targetBridgeId: string
}): Promise<string> {
  if (input.sourceBridgeId === input.targetBridgeId) {
    return input.sourceStoredPath
  }

  const inflightKey = `${input.libraryFileId}:${input.targetBridgeId}`
  const inflight = inflightReplicaBuilds.get(inflightKey)
  if (inflight) return await inflight
  const build = ensureLibraryFileReplicaUncoalesced(input)
  inflightReplicaBuilds.set(inflightKey, build)
  try {
    return await build
  } finally {
    inflightReplicaBuilds.delete(inflightKey)
  }
}

async function ensureLibraryFileReplicaUncoalesced(input: {
  tenantId: string
  libraryFileId: string
  fileName: string
  sourceBridgeId: string | null
  sourceStoredPath: string
  sizeBytes: number
  targetBridgeId: string
}): Promise<string> {
  const existing = await prisma.libraryFileReplica.findUnique({
    where: {
      libraryFileId_bridgeId: {
        libraryFileId: input.libraryFileId,
        bridgeId: input.targetBridgeId
      }
    },
    select: {
      storedPath: true,
      status: true
    }
  })
  if (existing?.status === 'ready') {
    await prisma.libraryFileReplica.update({
      where: {
        libraryFileId_bridgeId: {
          libraryFileId: input.libraryFileId,
          bridgeId: input.targetBridgeId
        }
      },
      data: {
        lastAccessedAt: new Date(),
        lastVerifiedAt: new Date(),
        errorMessage: null
      }
    })
    return existing.storedPath
  }

  const storedPath = existing?.storedPath ?? buildReplicaStoredPath(input.libraryFileId, input.fileName)
  const now = new Date()
  const contentHash = await copyBridgeLibraryFileBetweenBridges({
    sourceBridgeId: requireLibraryOwnerBridgeId(input.sourceBridgeId),
    sourceStoredPath: input.sourceStoredPath,
    targetBridgeId: input.targetBridgeId,
    targetStoredPath: storedPath
  })
  await prisma.libraryFileReplica.upsert({
    where: {
      libraryFileId_bridgeId: {
        libraryFileId: input.libraryFileId,
        bridgeId: input.targetBridgeId
      }
    },
    update: {
      storedPath,
      sizeBytes: input.sizeBytes,
      contentHash,
      status: 'ready',
      lastVerifiedAt: now,
      lastAccessedAt: now,
      errorMessage: null,
      expiresAt: null
    },
    create: {
      tenantId: input.tenantId,
      libraryFileId: input.libraryFileId,
      bridgeId: input.targetBridgeId,
      storedPath,
      sizeBytes: input.sizeBytes,
      contentHash,
      status: 'ready',
      lastVerifiedAt: now,
      lastAccessedAt: now,
      replicaKind: 'dispatch-cache'
    }
  })
  return storedPath
}

function resolveBridgeLibraryCachePath(bridgeId: string, storedPath: string): string {
  return path.join(bridgeLibraryCacheDir, bridgeId, path.basename(storedPath))
}

async function resolveExistingBridgeLibraryCachePath(bridgeId: string, storedPath: string): Promise<string | null> {
  const cachePath = resolveBridgeLibraryCachePath(bridgeId, storedPath)
  try {
    const info = await stat(cachePath)
    return info.size > 0 ? cachePath : null
  } catch {
    return null
  }
}

async function readCachedBridgeLibraryThreeMfIndex(
  bridgeId: string,
  storedPath: string,
  signal?: AbortSignal
): Promise<BridgeLibraryThreeMfIndex | null> {
  const cachePath = await resolveExistingBridgeLibraryCachePath(bridgeId, storedPath)
  if (!cachePath) return null
  const info = await stat(cachePath)
  const cached = bridgeThreeMfIndexCache.get(cachePath)
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return cached.index
  }
  const index = await readPlateIndex(cachePath, signal)
  bridgeThreeMfIndexCache.set(cachePath, {
    mtimeMs: info.mtimeMs,
    size: info.size,
    index
  })
  return index
}

async function clearBridgeLibraryLocalCache(bridgeId: string, storedPath: string): Promise<void> {
  const cachePath = resolveBridgeLibraryCachePath(bridgeId, storedPath)
  bridgeThreeMfIndexCache.delete(cachePath)
  await Promise.all([
    rm(cachePath, { force: true }).catch(() => undefined),
    rm(resolveBridgeLibraryDerivedCachePath(bridgeId, storedPath), { recursive: true, force: true }).catch(() => undefined)
  ])
}

function resolveBridgeLibraryDerivedCachePath(bridgeId: string, storedPath: string): string {
  const digest = createHash('sha256').update(`${bridgeId}\0${storedPath}`).digest('hex')
  // Version segment invalidates older derived indexes (e.g. those parsed before per-plate
  // `objects` existed) — old directories become orphaned and are removed by TTL pruning.
  return path.join(bridgeLibraryDerivedCacheDir, bridgeId, `v${BRIDGE_LIBRARY_DERIVED_CACHE_VERSION}`, digest)
}

async function readCachedBridgeLibraryDerivedIndex(bridgeId: string, storedPath: string): Promise<BridgeLibraryThreeMfIndex | null> {
  try {
    const raw = await readFile(path.join(resolveBridgeLibraryDerivedCachePath(bridgeId, storedPath), 'index.json'), 'utf8')
    return bridgeLibraryThreeMfIndexSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

async function writeCachedBridgeLibraryDerivedIndex(
  bridgeId: string,
  storedPath: string,
  index: BridgeLibraryThreeMfIndex
): Promise<void> {
  const cacheDir = resolveBridgeLibraryDerivedCachePath(bridgeId, storedPath)
  await mkdir(cacheDir, { recursive: true })
  await writeFile(path.join(cacheDir, 'index.json'), JSON.stringify(index), 'utf8')
}

async function readCachedBridgeLibraryThumbnail(
  bridgeId: string,
  storedPath: string,
  plateIndex: number | null
): Promise<Buffer | null> {
  try {
    return await readFile(path.join(resolveBridgeLibraryDerivedCachePath(bridgeId, storedPath), thumbnailCacheName(plateIndex)))
  } catch {
    return null
  }
}

async function writeCachedBridgeLibraryThumbnail(
  bridgeId: string,
  storedPath: string,
  plateIndex: number | null,
  png: Buffer
): Promise<void> {
  const cacheDir = resolveBridgeLibraryDerivedCachePath(bridgeId, storedPath)
  await mkdir(cacheDir, { recursive: true })
  await writeFile(path.join(cacheDir, thumbnailCacheName(plateIndex)), png)
}

function thumbnailCacheName(plateIndex: number | null): string {
  return `thumbnail-${plateIndex ?? 'default'}.png`
}

async function pruneDerivedCacheDirectory(dirPath: string, maxAgeMs: number): Promise<{
  removedFiles: number
  removedDirs: number
}> {
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => [])
  let removedFiles = 0
  let removedDirs = 0
  const now = Date.now()

  for (const entry of entries) {
    const childPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      const result = await pruneDerivedCacheDirectory(childPath, maxAgeMs)
      removedFiles += result.removedFiles
      removedDirs += result.removedDirs
      const remaining = await readdir(childPath).catch(() => null)
      if (remaining && remaining.length === 0) {
        await rm(childPath, { recursive: true, force: true }).catch(() => undefined)
        removedDirs += 1
      }
      continue
    }

    try {
      const info = await stat(childPath)
      if (now - info.mtimeMs <= maxAgeMs) continue
      await rm(childPath, { force: true })
      removedFiles += 1
    } catch {
      // Ignore races with concurrent cache readers/writers.
    }
  }

  return { removedFiles, removedDirs }
}

async function beginBridgeLibraryWrite(bridgeId: string, storedPath: string): Promise<void> {
  await requestBridgeLibraryRpc(bridgeId, 'library.storeStart', { storedPath })
}

async function appendBridgeLibraryChunk(bridgeId: string, storedPath: string, chunk: Buffer): Promise<void> {
  await requestBridgeLibraryRpc(bridgeId, 'library.storeChunk', {
    storedPath,
    chunkBase64: chunk.toString('base64')
  })
}

async function requestBridgeLibraryChunk(bridgeId: string, storedPath: string, offset: number, signal?: AbortSignal) {
  return bridgeLibraryReadChunkResultSchema.parse(await requestBridgeLibraryRpc(
    bridgeId,
    'library.readChunk',
    {
      storedPath,
      offset,
      maxBytes: BRIDGE_LIBRARY_TRANSFER_CHUNK_BYTES
    },
    signal
  ))
}

async function copyBridgeLibraryFileToLocalCache(bridgeId: string, storedPath: string, targetPath: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true })
  const handle = await open(targetPath, 'w')
  let offset = 0

  try {
    for (;;) {
      const result = await requestBridgeLibraryChunk(bridgeId, storedPath, offset)
      if (result.bufferBase64 == null) {
        throw new Error('ENOENT')
      }

      const chunk = Buffer.from(result.bufferBase64, 'base64')
      if (chunk.byteLength > 0) {
        await handle.write(chunk)
        offset += chunk.byteLength
      }
      if (result.eof) {
        return
      }
      if (chunk.byteLength === 0) {
        throw new Error('Bridge library read returned an empty chunk before EOF')
      }
    }
  } catch (error) {
    await rm(targetPath, { force: true }).catch(() => undefined)
    throw error
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function copyBridgeLibraryFileBetweenBridges(input: {
  sourceBridgeId: string
  sourceStoredPath: string
  targetBridgeId: string
  targetStoredPath: string
}): Promise<string> {
  await beginBridgeLibraryWrite(input.targetBridgeId, input.targetStoredPath)
  const hash = createHash('sha256')
  let offset = 0

  try {
    for (;;) {
      const result = await requestBridgeLibraryChunk(input.sourceBridgeId, input.sourceStoredPath, offset)
      if (result.bufferBase64 == null) {
        throw new Error('ENOENT')
      }

      const chunk = Buffer.from(result.bufferBase64, 'base64')
      if (chunk.byteLength > 0) {
        hash.update(chunk)
        await appendBridgeLibraryChunk(input.targetBridgeId, input.targetStoredPath, chunk)
        offset += chunk.byteLength
      }
      if (result.eof) {
        return hash.digest('hex')
      }
      if (chunk.byteLength === 0) {
        throw new Error('Bridge library read returned an empty chunk before EOF')
      }
    }
  } catch (error) {
    await deleteBridgeLibraryFile(input.targetBridgeId, input.targetStoredPath).catch(() => undefined)
    throw error
  }
}

async function requestBridgeLibraryRpc(
  bridgeId: string,
  method: string,
  params: unknown,
  signal?: AbortSignal
): Promise<unknown> {
  if (!bridgeSessionManager.isConnected(bridgeId)) {
    throw new Error(bridgeUnavailableMessage())
  }

  if (!signal) return await bridgeSessionManager.requestRpc(bridgeId, method, params)
  const { requestId, promise: rpcPromise } = bridgeSessionManager.startRpcRequest(bridgeId, method, params)
  if (signal.aborted) throw createAbortError('Aborted')

  return await new Promise<unknown>((resolve, reject) => {
    const onAbort = () => {
      bridgeSessionManager.cancelRpcRequest(requestId)
      reject(createAbortError('Aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    rpcPromise.then(
      (result) => {
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

function buildReplicaStoredPath(libraryFileId: string, fileName: string): string {
  const safeBase = path.basename(fileName).replace(/[^\w.-]+/g, '_')
  return `replica-${libraryFileId}-${safeBase}`
}