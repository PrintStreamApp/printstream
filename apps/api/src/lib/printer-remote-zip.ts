/**
 * Read selected ZIP entries from a printer-side archive over FTPS.
 *
 * FTP restart offsets let us download a suffix of the remote file. We use
 * that to read the ZIP central directory near EOF, find the local header
 * offsets for the entries we care about, and then download only the suffix
 * from the earliest needed local header to EOF instead of the whole archive.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInflateRaw, inflateRawSync } from 'node:zlib'
import { createAbortError, type Printer } from '@printstream/shared'
import { env } from './env.js'
import { downloadFileFromPrinterOffset, readPrinterZipEntriesViaBridge as readPrinterZipEntriesRpc } from './printer-ftp.js'

const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50
const ZIP_TAIL_SCAN_BYTES = 256 * 1024
const MAX_REMOTE_ZIP_SUFFIX_BYTES = 8 * 1024 * 1024
const MAX_REMOTE_ZIP_PREFIX_BYTES = 6 * 1024 * 1024
const REMOTE_ZIP_SMALL_PREFIX_BYTES = 256 * 1024
const REMOTE_ZIP_MEDIUM_PREFIX_BYTES = 2 * 1024 * 1024
const GENERAL_PURPOSE_FLAG_DATA_DESCRIPTOR = 0x0008
const SLOW_REMOTE_ZIP_LOG_THRESHOLD_MS = 250
const REMOTE_ZIP_PREFIX_CACHE_TTL_MS = 15_000
const RESTART_OFFSET_HINT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const RESTART_OFFSET_HINTS_FILE = env.NODE_ENV === 'test'
  ? null
  : path.resolve(path.dirname(env.LIBRARY_DIR), 'printer-zip-transport-hints.json')
const printerRestartOffsetSupport = new Map<string, boolean>()
const remoteZipPrefixCache = new Map<string, { maxBytes: number; buffer: Buffer; expiresAt: number }>()
const remoteZipPrefixInflight = new Map<string, { maxBytes: number; promise: Promise<Buffer> }>()
let restartOffsetHintsHydrationPromise: Promise<void> | null = null
let restartOffsetHintsPersistPromise: Promise<void> = Promise.resolve()

interface PersistedRestartOffsetHint {
  printerKey: string
  restartOffsetSupported: false
  expiresAt: number
}

export function clearPrinterZipTransportHints(): void {
  printerRestartOffsetSupport.clear()
  remoteZipPrefixCache.clear()
  remoteZipPrefixInflight.clear()
  restartOffsetHintsHydrationPromise = null
}

export async function readPrinterZipEntries(
  printer: Printer,
  remotePath: string,
  entryPaths: string[],
  signal?: AbortSignal
): Promise<Map<string, Buffer>> {
  if (entryPaths.length === 0) return new Map()

  await ensureRestartOffsetHintsHydrated()

  const startedAt = Date.now()
  let remoteSize = 0

  const readByPrefix = async (mode: 'prefix-direct' | 'prefix-fallback', error?: string, suffixDurationMs?: number) => {
    const prefixBudget = estimateZipPrefixBudget(entryPaths)
    const prefixStartedAt = Date.now()
    const { buffer: prefix, bytesRead, cacheHit } = await readPrinterZipPrefix(printer, remotePath, prefixBudget, signal)
    const result = await extractZipEntriesFromPrefix(prefix, entryPaths)
    logRemoteZipRead(printer, {
      mode,
      remotePath,
      requestedCount: entryPaths.length,
      foundCount: result.size,
      totalMs: Date.now() - prefixStartedAt,
      remoteSize,
      bytesRead,
      prefixBudget,
      suffixDurationMs,
      error,
      cacheHit
    })
    return result
  }

  if (printerRestartOffsetSupport.get(buildRestartOffsetSupportKey(printer)) === false) {
    return readByPrefix('prefix-direct', 'cached-rest-unsupported')
  }

  try {
    const rpcResult = await readPrinterZipEntriesRpc(printer, remotePath, entryPaths, {
      tailScanBytes: ZIP_TAIL_SCAN_BYTES,
      maxSuffixBytes: MAX_REMOTE_ZIP_SUFFIX_BYTES,
      signal
    })
    remoteSize = rpcResult.remoteSize
    const bytesRead = rpcResult.bytesRead
    const result = new Map<string, Buffer>()
    for (const [entryPath, base64] of Object.entries(rpcResult.entries)) {
      result.set(entryPath, Buffer.from(base64, 'base64'))
    }
    const durationMs = Date.now() - startedAt
    if (durationMs >= SLOW_REMOTE_ZIP_LOG_THRESHOLD_MS || result.size !== entryPaths.length) {
      logRemoteZipRead(printer, {
        mode: 'suffix',
        remotePath,
        requestedCount: entryPaths.length,
        foundCount: result.size,
        totalMs: durationMs,
        remoteSize,
        bytesRead
      })
    }
    return result
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error
    const suffixDurationMs = Date.now() - startedAt
    const message = error instanceof Error ? error.message : String(error)
    if (/\b502\b/.test(message)) {
      await rememberRestartOffsetSupport(printer, false)
    }
    return readByPrefix('prefix-fallback', message, suffixDurationMs)
  }
}

function buildRestartOffsetSupportKey(printer: Printer): string {
  return printer.serial || printer.id
}

async function withPrinterPrefixFetch(
  printer: Printer,
  remotePath: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Buffer> {
  return await downloadFileFromPrinterOffset(printer, remotePath, 0, undefined, {
    signal,
    maxBytes,
    truncateAtMaxBytes: true
  })
}

async function readPrinterZipPrefix(
  printer: Printer,
  remotePath: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<{ buffer: Buffer; bytesRead: number; cacheHit: boolean }> {
  if (signal?.aborted) throw createAbortError('The operation was aborted')

  const cacheKey = buildPrefixCacheKey(printer, remotePath)
  const cached = remoteZipPrefixCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now() && cached.maxBytes >= maxBytes) {
    return { buffer: cached.buffer, bytesRead: 0, cacheHit: true }
  }
  if (cached && cached.expiresAt <= Date.now()) {
    remoteZipPrefixCache.delete(cacheKey)
  }

  const inflight = remoteZipPrefixInflight.get(cacheKey)
  if (inflight && inflight.maxBytes >= maxBytes) {
    const buffer = await inflight.promise
    if (signal?.aborted) throw createAbortError('The operation was aborted')
    return { buffer, bytesRead: 0, cacheHit: true }
  }

  const promise = withPrinterPrefixFetch(printer, remotePath, maxBytes, signal).then((buffer) => {
    remoteZipPrefixCache.set(cacheKey, {
      maxBytes,
      buffer,
      expiresAt: Date.now() + REMOTE_ZIP_PREFIX_CACHE_TTL_MS
    })
    return buffer
  })
  remoteZipPrefixInflight.set(cacheKey, { maxBytes, promise })

  try {
    const buffer = await promise
    if (signal?.aborted) throw createAbortError('The operation was aborted')
    return { buffer, bytesRead: buffer.byteLength, cacheHit: false }
  } finally {
    const current = remoteZipPrefixInflight.get(cacheKey)
    if (current?.promise === promise) remoteZipPrefixInflight.delete(cacheKey)
  }
}

function buildPrefixCacheKey(printer: Printer, remotePath: string): string {
  return `${buildRestartOffsetSupportKey(printer)}\u0000${remotePath}`
}

async function rememberRestartOffsetSupport(printer: Printer, supported: boolean): Promise<void> {
  printerRestartOffsetSupport.set(buildRestartOffsetSupportKey(printer), supported)
  await persistRestartOffsetHintsSoon()
}

async function ensureRestartOffsetHintsHydrated(): Promise<void> {
  restartOffsetHintsHydrationPromise ??= hydrateRestartOffsetHintsFromDisk()
  await restartOffsetHintsHydrationPromise
}

async function hydrateRestartOffsetHintsFromDisk(): Promise<void> {
  if (!RESTART_OFFSET_HINTS_FILE) return

  let raw = ''
  try {
    raw = await readFile(RESTART_OFFSET_HINTS_FILE, 'utf8')
  } catch {
    return
  }

  try {
    const parsed = JSON.parse(raw) as { entries?: PersistedRestartOffsetHint[] }
    const entries = Array.isArray(parsed.entries) ? parsed.entries : []
    const now = Date.now()
    for (const entry of entries) {
      if (!isPersistedRestartOffsetHint(entry)) continue
      if (entry.expiresAt <= now) continue
      printerRestartOffsetSupport.set(entry.printerKey, false)
    }
  } catch {
    await rm(RESTART_OFFSET_HINTS_FILE, { force: true }).catch(() => undefined)
  }
}

function isPersistedRestartOffsetHint(value: unknown): value is PersistedRestartOffsetHint {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PersistedRestartOffsetHint>
  return typeof candidate.printerKey === 'string'
    && candidate.restartOffsetSupported === false
    && typeof candidate.expiresAt === 'number'
}

function persistRestartOffsetHintsSoon(): Promise<void> {
  if (!RESTART_OFFSET_HINTS_FILE) return Promise.resolve()
  restartOffsetHintsPersistPromise = restartOffsetHintsPersistPromise
    .then(() => persistRestartOffsetHintsToDisk())
    .catch(() => undefined)
  return restartOffsetHintsPersistPromise
}

async function persistRestartOffsetHintsToDisk(): Promise<void> {
  if (!RESTART_OFFSET_HINTS_FILE) return

  const entries: PersistedRestartOffsetHint[] = []
  const expiresAt = Date.now() + RESTART_OFFSET_HINT_TTL_MS
  for (const [printerKey, supported] of printerRestartOffsetSupport.entries()) {
    if (supported !== false) continue
    entries.push({ printerKey, restartOffsetSupported: false, expiresAt })
  }

  await mkdir(path.dirname(RESTART_OFFSET_HINTS_FILE), { recursive: true })
  const tempPath = `${RESTART_OFFSET_HINTS_FILE}.tmp`
  await writeFile(tempPath, JSON.stringify({ entries }), 'utf8')
  await rename(tempPath, RESTART_OFFSET_HINTS_FILE)
}

function logRemoteZipRead(printer: Printer, details: {
  mode: 'suffix' | 'prefix-direct' | 'prefix-fallback'
  remotePath: string
  requestedCount: number
  foundCount: number
  totalMs: number
  remoteSize: number
  bytesRead: number
  prefixBudget?: number
  suffixDurationMs?: number
  error?: string
  cacheHit?: boolean
}): void {
  const parts = [
    `[printer-zip:${printer.name}]`,
    `mode=${details.mode}`,
    `totalMs=${details.totalMs}`,
    `requested=${details.requestedCount}`,
    `found=${details.foundCount}`,
    `bytesRead=${details.bytesRead}`,
    `remoteSize=${details.remoteSize}`,
    `path=${details.remotePath}`
  ]
  if (details.prefixBudget != null) parts.push(`prefixBudget=${details.prefixBudget}`)
  if (details.suffixDurationMs != null) parts.push(`suffixMs=${details.suffixDurationMs}`)
  if (details.error) parts.push(`error=${details.error}`)
  if (details.cacheHit != null) parts.push(`cacheHit=${details.cacheHit}`)
  console.info(parts.join(' '))
}

function estimateZipPrefixBudget(entryPaths: string[]): number {
  let maxBytes = REMOTE_ZIP_SMALL_PREFIX_BYTES

  for (const entryPath of entryPaths) {
    if (/^Metadata\/(?:slice_info|project_settings|model_settings)\.config$/i.test(entryPath)) {
      maxBytes = Math.max(maxBytes, REMOTE_ZIP_MEDIUM_PREFIX_BYTES)
      continue
    }
    if (/^Metadata\/plate_\d+\.gcode$/i.test(entryPath)) {
      maxBytes = Math.max(maxBytes, MAX_REMOTE_ZIP_PREFIX_BYTES)
      continue
    }
    if (!/^Metadata\/.*\.(?:png|config)$/i.test(entryPath)) {
      maxBytes = Math.max(maxBytes, REMOTE_ZIP_MEDIUM_PREFIX_BYTES)
    }
  }

  return maxBytes
}

async function extractZipEntriesFromPrefix(buffer: Buffer, entryPaths: string[]): Promise<Map<string, Buffer>> {
  const requested = new Set(entryPaths)
  const result = new Map<string, Buffer>()
  let offset = 0

  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset)
    if (signature === ZIP_CENTRAL_DIRECTORY_SIGNATURE || signature === ZIP_EOCD_SIGNATURE) break
    if (signature !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) break

    const flags = buffer.readUInt16LE(offset + 6)
    const compressionMethod = buffer.readUInt16LE(offset + 8)
    const fileNameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const nameEnd = nameStart + fileNameLength
    const dataStart = nameEnd + extraLength
    if (nameEnd > buffer.length || dataStart > buffer.length) break

    const entryPath = buffer.toString('utf8', nameStart, nameEnd)
    const usesDataDescriptor = (flags & GENERAL_PURPOSE_FLAG_DATA_DESCRIPTOR) !== 0

    let compressedSize = buffer.readUInt32LE(offset + 18)
    let dataEnd = dataStart + compressedSize
    let nextOffset = dataEnd
    let inflated: Buffer | null = null

    if (usesDataDescriptor) {
      if (compressionMethod === 8) {
        let streamed: { output: Buffer; compressedSize: number }
        try {
          streamed = await inflateZipEntryFromPrefix(buffer.subarray(dataStart))
        } catch {
          break
        }
        const descriptor = readSignedDataDescriptor(buffer, dataStart + streamed.compressedSize)
        if (!descriptor) break
        compressedSize = streamed.compressedSize
        dataEnd = descriptor.dataEnd
        nextOffset = descriptor.nextOffset
        inflated = streamed.output
      } else {
        const descriptor = findSignedDataDescriptor(buffer, dataStart)
        if (!descriptor) break
        compressedSize = descriptor.compressedSize
        dataEnd = descriptor.dataEnd
        nextOffset = descriptor.nextOffset
      }
    }

    if (dataEnd > buffer.length) break

    if (requested.has(entryPath)) {
      const compressed = buffer.subarray(dataStart, dataEnd)
      switch (compressionMethod) {
        case 0:
          result.set(entryPath, Buffer.from(compressed))
          break
        case 8:
          result.set(entryPath, inflated ?? inflateRawSync(compressed))
          break
        default:
          throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`)
      }
      if (result.size === requested.size) return result
    }

    if (nextOffset <= offset) break
    offset = nextOffset
  }

  return result
}

function findSignedDataDescriptor(
  buffer: Buffer,
  dataStart: number
): { compressedSize: number; dataEnd: number; nextOffset: number } | null {
  for (let offset = dataStart; offset + 16 <= buffer.length; offset += 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_DATA_DESCRIPTOR_SIGNATURE) continue

    const compressedSize = buffer.readUInt32LE(offset + 8)
    const dataEnd = offset
    if (compressedSize !== dataEnd - dataStart) continue

    const nextOffset = offset + 16
    if (nextOffset + 4 <= buffer.length) {
      const nextSignature = buffer.readUInt32LE(nextOffset)
      if (
        nextSignature !== ZIP_LOCAL_FILE_HEADER_SIGNATURE
        && nextSignature !== ZIP_CENTRAL_DIRECTORY_SIGNATURE
        && nextSignature !== ZIP_EOCD_SIGNATURE
      ) {
        continue
      }
    }

    return { compressedSize, dataEnd, nextOffset }
  }

  return null
}

function readSignedDataDescriptor(
  buffer: Buffer,
  dataEnd: number
): { dataEnd: number; nextOffset: number } | null {
  if (dataEnd + 16 > buffer.length) return null
  if (buffer.readUInt32LE(dataEnd) !== ZIP_DATA_DESCRIPTOR_SIGNATURE) return null

  const nextOffset = dataEnd + 16
  if (nextOffset + 4 <= buffer.length) {
    const nextSignature = buffer.readUInt32LE(nextOffset)
    if (
      nextSignature !== ZIP_LOCAL_FILE_HEADER_SIGNATURE
      && nextSignature !== ZIP_CENTRAL_DIRECTORY_SIGNATURE
      && nextSignature !== ZIP_EOCD_SIGNATURE
    ) {
      return null
    }
  }

  return { dataEnd, nextOffset }
}

async function inflateZipEntryFromPrefix(source: Buffer): Promise<{ output: Buffer; compressedSize: number }> {
  const inflate = createInflateRaw()
  const chunks: Buffer[] = []

  return await new Promise((resolve, reject) => {
    inflate.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk))
    })
    inflate.on('error', reject)
    inflate.on('end', () => {
      resolve({
        output: Buffer.concat(chunks),
        compressedSize: inflate.bytesWritten
      })
    })
    inflate.end(source)
  })
}