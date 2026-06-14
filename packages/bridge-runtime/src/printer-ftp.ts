/**
 * Bambu printer FTP client.
 *
 * Bambu printers expose an implicit-FTPS server on TCP 990 in
 * Developer/LAN mode. Files placed at the root are addressable from
 * MQTT print commands as `ftp:///<filename>`. Auth uses the same
 * `bblp` / access-code pair as MQTT.
 */
import { Client as FtpClient, type FileInfo, type FTPContext, type FTPResponse } from 'basic-ftp'
// `connectForPassiveTransfer`/`parsePasvResponse` are runtime exports of the
// transfer submodule but are not surfaced from the package root. Import the
// submodule statically (rather than via createRequire) so bundlers like the
// bridge's SEA build can follow the dependency.
import { connectForPassiveTransfer, parsePasvResponse } from 'basic-ftp/dist/transfer.js'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import type { TLSSocket } from 'node:tls'
import type { Printer } from '@printstream/shared'
import { beginFtpActivity } from './printer-transport-arbitration.js'

const FTP_PORT = 990
// Some P1-class printers take multiple minutes to finish an FTPS upload over
// weak Wi-Fi. Keep the control socket alive long enough for those transfers to
// complete before the client decides the printer is idle and aborts the job.
const FTP_SOCKET_TIMEOUT_MS = 5 * 60_000
const FTP_WRITE_OPERATION_COOLDOWN_MS = 250
const FTP_LIST_CACHE_TTL_MS = 15_000
const MAX_CONCURRENT_IN_MEMORY_FTP_DOWNLOADS = 2
const printerFtpQueues = new Map<string, Promise<void>>()
const printerFtpListCache = new Map<string, { expiresAt: number; entries: PrinterFsEntry[] }>()
const inMemoryDownloadWaiters: Array<() => void> = []
let activeInMemoryFtpDownloads = 0

type TunableSocket = (Socket | TLSSocket) & {
  setNoDelay?: (noDelay?: boolean) => void
  setKeepAlive?: (enable?: boolean, initialDelay?: number) => void
}

/**
 * PASV strategy that ignores the host returned by the server and
 * reuses the control-connection IP for the data socket. Mirrors
 * basic-ftp's `enterPassiveModeIPv4_forceControlHostIP`, which is
 * declared in the type defs but not exported at runtime.
 */
async function pasvForceControlHost(ftp: FTPContext): Promise<FTPResponse> {
  const res = await ftp.request('PASV')
  const { port } = parsePasvResponse(res.message)
  const controlHost = ftp.socket.remoteAddress
  if (!controlHost) {
    throw new Error("Control socket is disconnected, can't get remote address.")
  }
  await connectForPassiveTransfer(controlHost, port, ftp)
  return res
}

/** Lightweight DTO returned by `listPrinterDirectory()`. */
export interface PrinterFsEntry {
  name: string
  /**
   * Absolute printer-side path. Only populated by recursive listings
   * (`listPrinterDirectoryRecursive`), where the parent directory is
   * not implied by the request.
   */
  path?: string
  type: 'file' | 'directory'
  sizeBytes: number
  modifiedAt: string | null
}

export interface PrinterFtpTransportSettings {
  socketTimeoutMs?: number
  uploadReadHighWaterMarkBytes?: number
  socketNoDelay?: boolean
  socketKeepAlive?: boolean
  socketKeepAliveInitialDelayMs?: number
}

export interface ResolvedPrinterFtpTransportSettings {
  socketTimeoutMs: number
  uploadReadHighWaterMarkBytes: number
  socketNoDelay: boolean
  socketKeepAlive: boolean
  socketKeepAliveInitialDelayMs: number
}

export const DEFAULT_PRINTER_FTP_TRANSPORT_SETTINGS: ResolvedPrinterFtpTransportSettings = Object.freeze({
  socketTimeoutMs: FTP_SOCKET_TIMEOUT_MS,
  uploadReadHighWaterMarkBytes: 64 * 1024,
  socketNoDelay: false,
  socketKeepAlive: false,
  socketKeepAliveInitialDelayMs: 1_000
})

export interface PrinterFtpOptions {
  signal?: AbortSignal
  cooldownMs?: number
  maxBytes?: number
  truncateAtMaxBytes?: boolean
  transport?: PrinterFtpTransportSettings
}

export interface PrinterFtpUploadBenchmarkResult {
  path: string
  connectMs: number
  uploadMs: number
  totalMs: number
  bytesSent: number
}

export function resolvePrinterFtpTransportSettings(
  settings: PrinterFtpTransportSettings = {}
): ResolvedPrinterFtpTransportSettings {
  return {
    socketTimeoutMs: normalizePositiveInteger(settings.socketTimeoutMs, DEFAULT_PRINTER_FTP_TRANSPORT_SETTINGS.socketTimeoutMs),
    uploadReadHighWaterMarkBytes: normalizePositiveInteger(
      settings.uploadReadHighWaterMarkBytes,
      DEFAULT_PRINTER_FTP_TRANSPORT_SETTINGS.uploadReadHighWaterMarkBytes
    ),
    socketNoDelay: settings.socketNoDelay ?? DEFAULT_PRINTER_FTP_TRANSPORT_SETTINGS.socketNoDelay,
    socketKeepAlive: settings.socketKeepAlive ?? DEFAULT_PRINTER_FTP_TRANSPORT_SETTINGS.socketKeepAlive,
    socketKeepAliveInitialDelayMs: normalizeNonNegativeInteger(
      settings.socketKeepAliveInitialDelayMs,
      DEFAULT_PRINTER_FTP_TRANSPORT_SETTINGS.socketKeepAliveInitialDelayMs
    )
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
}

function createAbortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

function createFtpSizeExceededError(maxBytes: number): Error {
  const error = new Error(`FTP download exceeded the ${maxBytes} byte safety limit`)
  error.name = 'RangeError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError()
}

/**
 * Open a connected, authenticated FTPS client. Caller must `client.close()`.
 *
 * Bambu firmware advertises `0.0.0.0` as the PASV host, so we override
 * the data-channel target with the printer's control IP. Without this,
 * data transfers fail with `ECONNREFUSED 0.0.0.0:<port>`.
 */
function applySocketTuning(socket: TunableSocket | null | undefined, settings: ResolvedPrinterFtpTransportSettings): void {
  if (!socket) return
  socket.setNoDelay?.(settings.socketNoDelay)
  socket.setKeepAlive?.(settings.socketKeepAlive, settings.socketKeepAliveInitialDelayMs)
}

function getFtpDataSocket(ftp: FTPContext): TunableSocket | null {
  return ((ftp as FTPContext & { dataSocket?: TunableSocket | null }).dataSocket ?? null)
}

async function pasvForceControlHostWithTuning(
  ftp: FTPContext,
  settings: ResolvedPrinterFtpTransportSettings
): Promise<FTPResponse> {
  const response = await pasvForceControlHost(ftp)
  applySocketTuning(getFtpDataSocket(ftp), settings)
  return response
}

async function openFtp(printer: Printer, transport: PrinterFtpTransportSettings = {}): Promise<FtpClient> {
  const settings = resolvePrinterFtpTransportSettings(transport)
  // Weak Wi-Fi can briefly stall the FTPS data channel during larger uploads.
  // Keep the client timeout above those short pauses so transient link jitter
  // does not abort a transfer before dispatch-level retry logic can help.
  const client = new FtpClient(settings.socketTimeoutMs)
  await client.access({
    host: printer.host,
    port: FTP_PORT,
    user: 'bblp',
    password: printer.accessCode,
    secure: 'implicit',
    secureOptions: { rejectUnauthorized: false }
  })
  applySocketTuning(client.ftp.socket as TunableSocket | undefined, settings)
  client.prepareTransfer = (ftp) => pasvForceControlHostWithTuning(ftp, settings)
  return client
}

async function withQueuedFtp<T>(
  printer: Printer,
  operation: (client: FtpClient) => Promise<T>,
  options: PrinterFtpOptions = {}
): Promise<T> {
  return enqueuePrinterFtp(printer, async () => {
    const endFtpActivity = beginFtpActivity(printer.id)
    throwIfAborted(options.signal)
    try {
      const client = await openFtp(printer, options.transport)
      const onAbort = () => client.close()
      options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        throwIfAborted(options.signal)
        return await operation(client)
      } catch (error) {
        if (options.signal?.aborted) throw createAbortError()
        throw error
      } finally {
        options.signal?.removeEventListener('abort', onAbort)
        client.close()
      }
    } finally {
      endFtpActivity()
    }
  }, options)
}

export async function withPrinterFtpClient<T>(
  printer: Printer,
  operation: (client: FtpClient) => Promise<T>,
  options: PrinterFtpOptions = {}
): Promise<T> {
  return withInMemoryDownloadSlot(async () => withQueuedFtp(printer, operation, { ...options, cooldownMs: 0 }))
}

function enqueuePrinterFtp<T>(printer: Printer, operation: () => Promise<T>, options: PrinterFtpOptions = {}): Promise<T> {
  const queueKey = printer.serial || printer.id
  const previous = printerFtpQueues.get(queueKey) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(async () => {
    throwIfAborted(options.signal)
    try {
      return await operation()
    } finally {
      await cooldown(options.cooldownMs ?? FTP_WRITE_OPERATION_COOLDOWN_MS)
    }
  })
  const tail = run.then(() => undefined, () => undefined)
  printerFtpQueues.set(queueKey, tail)
  tail.finally(() => {
    if (printerFtpQueues.get(queueKey) === tail) {
      printerFtpQueues.delete(queueKey)
    }
  })
  return run
}

function cooldown(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

async function withInMemoryDownloadSlot<T>(operation: () => Promise<T>): Promise<T> {
  await acquireInMemoryDownloadSlot()
  try {
    return await operation()
  } finally {
    releaseInMemoryDownloadSlot()
  }
}

function acquireInMemoryDownloadSlot(): Promise<void> {
  if (activeInMemoryFtpDownloads < MAX_CONCURRENT_IN_MEMORY_FTP_DOWNLOADS) {
    activeInMemoryFtpDownloads += 1
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    inMemoryDownloadWaiters.push(() => {
      activeInMemoryFtpDownloads += 1
      resolve()
    })
  })
}

function releaseInMemoryDownloadSlot(): void {
  activeInMemoryFtpDownloads = Math.max(0, activeInMemoryFtpDownloads - 1)
  const next = inMemoryDownloadWaiters.shift()
  next?.()
}

function getCachedPrinterList(cacheKey: string): PrinterFsEntry[] | null {
  const cached = printerFtpListCache.get(cacheKey)
  if (!cached) return null
  if (cached.expiresAt <= Date.now()) {
    printerFtpListCache.delete(cacheKey)
    return null
  }
  return cached.entries
}

function setCachedPrinterList(cacheKey: string, entries: PrinterFsEntry[]): void {
  printerFtpListCache.set(cacheKey, {
    expiresAt: Date.now() + FTP_LIST_CACHE_TTL_MS,
    entries
  })
}

function clearCachedPrinterLists(printer: Printer): void {
  const prefix = `${printer.id}\u0000`
  for (const key of printerFtpListCache.keys()) {
    if (key.startsWith(prefix)) printerFtpListCache.delete(key)
  }
}

function durationMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000
}

async function uploadFileToPrinterPathWithClient(
  client: FtpClient,
  printer: Printer,
  localPath: string,
  normalizedRemotePath: string,
  uploadReadHighWaterMarkBytes: number,
  onProgress?: (bytesSent: number) => void
): Promise<{ path: string; bytesSent: number }> {
  const remoteDir = path.posix.dirname(normalizedRemotePath)
  const remoteFilename = path.posix.basename(normalizedRemotePath)
  let bytesSent = 0

  if (remoteDir !== '/' && remoteDir !== '.') {
    await client.cd(remoteDir)
  }

  const stream = createReadStream(localPath, { highWaterMark: uploadReadHighWaterMarkBytes })
  if (onProgress) {
    client.trackProgress((info) => {
      if (info.type !== 'upload') return
      bytesSent = info.bytes
      onProgress(info.bytes)
    })
  }

  try {
    await client.uploadFrom(stream, remoteFilename)
    clearCachedPrinterLists(printer)
  } finally {
    if (onProgress) client.trackProgress()
  }

  return { path: normalizedRemotePath, bytesSent }
}

/**
 * Upload a local file to the printer's root directory. Returns the
 * remote filename (the basename of the destination), which is what the
 * MQTT `project_file` command expects.
 */
export async function uploadFileToPrinter(
  printer: Printer,
  localPath: string,
  remoteFilename: string,
  onProgress?: (bytesSent: number) => void,
  options: PrinterFtpOptions = {}
): Promise<string> {
  const normalizedRemoteFilename = path.posix.basename(remoteFilename)
  await uploadFileToPrinterPath(printer, localPath, `/${normalizedRemoteFilename}`, onProgress, options)
  return normalizedRemoteFilename
}

/**
 * Upload a local file to an existing printer-storage path.
 *
 * FTPS operations are serialized per printer through `withQueuedFtp`, so
 * uploads, downloads, directory reads, and renames do not run in parallel
 * against the same machine.
 */
export async function uploadFileToPrinterPath(
  printer: Printer,
  localPath: string,
  remotePath: string,
  onProgress?: (bytesSent: number) => void,
  options: PrinterFtpOptions = {}
): Promise<string> {
  const normalizedRemotePath = '/' + remotePath.split('/').filter(Boolean).join('/')
  const transportSettings = resolvePrinterFtpTransportSettings(options.transport)

  return withQueuedFtp(printer, async (client) => {
    const uploaded = await uploadFileToPrinterPathWithClient(
      client,
      printer,
      localPath,
      normalizedRemotePath,
      transportSettings.uploadReadHighWaterMarkBytes,
      onProgress
    )
    return uploaded.path
  }, options)
}

export async function benchmarkUploadFileToPrinterPath(
  printer: Printer,
  localPath: string,
  remotePath: string,
  onProgress?: (bytesSent: number) => void,
  options: PrinterFtpOptions = {}
): Promise<PrinterFtpUploadBenchmarkResult> {
  const normalizedRemotePath = '/' + remotePath.split('/').filter(Boolean).join('/')
  const transportSettings = resolvePrinterFtpTransportSettings(options.transport)

  return enqueuePrinterFtp(printer, async () => {
    const endFtpActivity = beginFtpActivity(printer.id)
    const startedAt = process.hrtime.bigint()
    throwIfAborted(options.signal)
    let client: FtpClient | null = null
    let onAbort: (() => void) | null = null

    try {
      const connectStartedAt = process.hrtime.bigint()
      client = await openFtp(printer, options.transport)
      const connectMs = durationMs(connectStartedAt)

      onAbort = () => client?.close()
      options.signal?.addEventListener('abort', onAbort, { once: true })

      throwIfAborted(options.signal)
      const uploadStartedAt = process.hrtime.bigint()
      const uploaded = await uploadFileToPrinterPathWithClient(
        client,
        printer,
        localPath,
        normalizedRemotePath,
        transportSettings.uploadReadHighWaterMarkBytes,
        onProgress
      )

      return {
        path: uploaded.path,
        connectMs,
        uploadMs: durationMs(uploadStartedAt),
        totalMs: durationMs(startedAt),
        bytesSent: uploaded.bytesSent
      }
    } catch (error) {
      if (options.signal?.aborted) throw createAbortError()
      throw error
    } finally {
      if (onAbort) {
        options.signal?.removeEventListener('abort', onAbort)
      }
      client?.close()
      endFtpActivity()
    }
  }, options)
}

/**
 * Download a single file from the printer to a local buffer. Tries each
 * candidate path in order and returns the first one that exists.
 *
 * Bambu firmwares store user-uploaded prints at the FTPS root, but
 * cloud-initiated prints land under `/cache/`, so callers typically
 * pass both candidates. Returns `null` when none of the candidates are
 * available.
 */
export async function downloadFileFromPrinter(
  printer: Printer,
  candidates: string[],
  onProgress?: (bytesReceived: number) => void,
  options: PrinterFtpOptions = {}
): Promise<Buffer | null> {
  if (candidates.length === 0) return null
  return withQueuedFtp(printer, async (client) => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-cover-'))
    const tempFile = path.join(tempDir, 'download.bin')
    try {
      for (const remote of candidates) {
        for (const variant of buildPrinterPathVariants(remote)) {
          throwIfAborted(options.signal)
          try {
            const stream = createWriteStream(tempFile)
            if (onProgress) {
              client.trackProgress((info) => {
                if (info.type === 'download') onProgress(info.bytes)
              })
            }
            try {
              await client.downloadTo(stream, variant)
            } finally {
              if (onProgress) client.trackProgress()
            }
            return await readFile(tempFile)
          } catch {
            // Try the next path variant.
          }
        }
      }
      return null
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }, { ...options, cooldownMs: 0 })
}

/** Stream a single printer-side file directly into a writable target. */
export async function streamFileFromPrinter(
  printer: Printer,
  remotePath: string,
  writable: Writable,
  onProgress?: (bytesReceived: number) => void,
  options: PrinterFtpOptions = {}
): Promise<void> {
  await withQueuedFtp(printer, async (client) => {
    let lastError: unknown = null
    for (const variant of buildPrinterPathVariants(remotePath)) {
      if (onProgress) {
        client.trackProgress((info) => {
          if (info.type === 'download') onProgress(info.bytes)
        })
      }
      try {
        await client.downloadTo(writable, variant)
        return
      } catch (error) {
        lastError = error
      } finally {
        if (onProgress) client.trackProgress()
      }
    }
    throw lastError ?? new Error('File not found')
  }, { ...options, cooldownMs: 0 })
}

/** Look up the remote size of a single printer-side file. */
export async function getPrinterFileSize(
  printer: Printer,
  remotePath: string,
  options: PrinterFtpOptions = {}
): Promise<number> {
  return withQueuedFtp(printer, async (client) => {
    let lastError: unknown = null
    for (const variant of buildPrinterPathVariants(remotePath)) {
      try {
        return await client.size(variant)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error('File not found')
  }, { ...options, cooldownMs: 0 })
}

/**
 * Download a suffix of a printer-side file, starting at `startAt` and
 * continuing to EOF. FTP supports restart offsets but not bounded byte
 * ranges, so callers should keep `startAt` close to the desired data.
 */
export async function downloadFileFromPrinterOffset(
  printer: Printer,
  remotePath: string,
  startAt: number,
  onProgress?: (bytesReceived: number) => void,
  options: PrinterFtpOptions = {}
): Promise<Buffer> {
  return withPrinterFtpClient(
    printer,
    async (client) => {
      let lastError: unknown = null
      for (const variant of buildPrinterPathVariants(remotePath)) {
        try {
          return await downloadFileFromPrinterOffsetWithClient(client, variant, startAt, onProgress, options)
        } catch (error) {
          lastError = error
        }
      }
      throw lastError ?? new Error('File not found')
    },
    options
  )
}

export async function downloadFileFromPrinterOffsetWithClient(
  client: FtpClient,
  remotePath: string,
  startAt: number,
  onProgress?: (bytesReceived: number) => void,
  options: PrinterFtpOptions = {}
): Promise<Buffer> {
  throwIfAborted(options.signal)

  const chunks: Buffer[] = []
  let totalBytes = 0
  let overflowError: Error | null = null
  let truncated = false
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      if (overflowError) {
        callback()
        return
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const maxBytes = typeof options.maxBytes === 'number' && options.maxBytes > 0 ? options.maxBytes : null
      if (maxBytes != null && totalBytes + buffer.byteLength > maxBytes) {
        const remaining = Math.max(0, maxBytes - totalBytes)
        if (options.truncateAtMaxBytes) {
          if (remaining > 0) chunks.push(buffer.subarray(0, remaining))
          totalBytes = maxBytes
          truncated = true
          client.close()
          callback()
          return
        }

        overflowError = createFtpSizeExceededError(maxBytes)
        client.close()
        callback()
        return
      }

      totalBytes += buffer.byteLength
      chunks.push(buffer)
      callback()
    }
  })

  if (onProgress) {
    client.trackProgress((info) => {
      if (info.type === 'download') onProgress(info.bytes)
    })
  }

  try {
    await client.downloadTo(writable, remotePath, Math.max(0, Math.trunc(startAt)))
    if (overflowError) throw overflowError
    throwIfAborted(options.signal)
    return Buffer.concat(chunks)
  } catch (error) {
    if (truncated) return Buffer.concat(chunks)
    if (overflowError) throw overflowError
    if (options.signal?.aborted) throw createAbortError()
    throw error
  } finally {
    if (onProgress) client.trackProgress()
  }
}

/**
 * List directory entries at the given printer-relative path. The root
 * is `'/'`. Hidden dot-files are skipped because Bambu firmware uses
 * them for internal state. Returns entries sorted by name with
 * directories first.
 */
export async function listPrinterDirectory(
  printer: Printer,
  dirPath: string,
  options: PrinterFtpOptions = {}
): Promise<PrinterFsEntry[]> {
  const target = dirPath || '/'
  const cacheKey = `${printer.id}\u0000list\u0000${target}`
  const cached = getCachedPrinterList(cacheKey)
  if (cached) return cached

  return withQueuedFtp(printer, async (client) => {
    let entries: PrinterFsEntry[] = []
    let lastError: unknown = null
    for (const variant of buildPrinterPathVariants(target)) {
      try {
        const list = await client.list(variant)
        const mappedEntries = list
          .filter((entry) => !entry.name.startsWith('.') && entry.name !== '..')
          .map((entry) => ({
            name: entry.name,
            type: entry.isDirectory ? ('directory' as const) : ('file' as const),
            sizeBytes: entry.size ?? 0,
            modifiedAt: entry.modifiedAt ? entry.modifiedAt.toISOString() : null
          }))
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
            return a.name.localeCompare(b.name)
          })
        entries = mappedEntries
        if (entries.length > 0 || variant === target || target === '/') break
      } catch (error) {
        lastError = error
      }
    }
    if (entries.length === 0 && lastError && target !== '/') {
      throw lastError
    }
    setCachedPrinterList(cacheKey, entries)
    return entries
  }, { ...options, cooldownMs: 0 })
}

/**
 * Walk the printer's filesystem starting at `rootPath` and return every
 * file (no directories) up to `maxDepth` levels deep. Each returned
 * entry includes its absolute printer-side `path`. Performed inside a
 * single queued FTP session so recursion doesn't multiply the per-op
 * cooldown across folders.
 *
 * `skipDirectories` is matched against directory names (case-insensitive)
 * at any depth. The Models browser uses this to avoid descending into
 * Bambu firmware folders that never contain user prints (camera dumps,
 * loggers, language packs, timelapses, etc.) which keeps the listing
 * fast on printers with full SD cards.
 */
export async function listPrinterDirectoryRecursive(
  printer: Printer,
  rootPath: string,
  maxDepth = 4,
  skipDirectories: ReadonlySet<string> = new Set(),
  options: PrinterFtpOptions = {}
): Promise<PrinterFsEntry[]> {
  const target = rootPath || '/'
  const cacheKey = `${printer.id}\u0000recursive\u0000${target}\u0000${maxDepth}\u0000${Array.from(skipDirectories).join(',')}`
  const cached = getCachedPrinterList(cacheKey)
  if (cached) return cached

  return withQueuedFtp(printer, async (client) => {
    const out: PrinterFsEntry[] = []
    const walk = async (dir: string, depth: number): Promise<void> => {
      throwIfAborted(options.signal)
      const list = await listPrinterDirectoryVariants(client, dir || '/')
      for (const entry of list) {
        if (entry.name.startsWith('.') || entry.name === '..') continue
        const full = dir === '/' || dir === '' ? `/${entry.name}` : `${dir}/${entry.name}`
        if (entry.isDirectory) {
          if (skipDirectories.has(entry.name.toLowerCase())) continue
          if (depth < maxDepth) {
            try {
              await walk(full, depth + 1)
            } catch {
              // Skip subtrees we can't enter (permission, transient error).
            }
          }
          continue
        }
        out.push({
          name: entry.name,
          path: full,
          type: 'file',
          sizeBytes: entry.size ?? 0,
          modifiedAt: entry.modifiedAt ? entry.modifiedAt.toISOString() : null
        })
      }
    }
    await walk(rootPath || '/', 0)
    out.sort((a, b) => {
      const ta = Date.parse(a.modifiedAt ?? '') || 0
      const tb = Date.parse(b.modifiedAt ?? '') || 0
      if (ta !== tb) return tb - ta
      return a.name.localeCompare(b.name)
    })
    setCachedPrinterList(cacheKey, out)
    return out
  }, { ...options, cooldownMs: 0 })
}

function buildPrinterPathVariants(inputPath: string): string[] {
  if (!inputPath || inputPath === '/') return ['/']

  const normalized = '/' + inputPath.split('/').filter(Boolean).join('/')
  const variants = [normalized]
  const relative = normalized.replace(/^\//, '')
  if (relative && relative !== normalized) variants.push(relative)
  return Array.from(new Set(variants))
}

async function listPrinterDirectoryVariants(client: FtpClient, dir: string): Promise<FileInfo[]> {
  let lastError: unknown = null
  for (const variant of buildPrinterPathVariants(dir)) {
    try {
      const list = await client.list(variant)
      if (list.length > 0 || variant === dir || dir === '/') return list
    } catch (error) {
      lastError = error
    }
  }
  if (lastError) throw lastError
  return []
}

/** Delete a single file on the printer. */
export async function deletePrinterFile(printer: Printer, filePath: string): Promise<void> {
  await withQueuedFtp(printer, async (client) => {
    await client.remove(filePath)
    clearCachedPrinterLists(printer)
  })
}

/** Delete an empty directory on the printer. */
export async function deletePrinterDirectory(printer: Printer, dirPath: string): Promise<void> {
  await withQueuedFtp(printer, async (client) => {
    await client.removeEmptyDir(dirPath)
    clearCachedPrinterLists(printer)
  })
}

/** Rename or move a file/directory on the printer. */
export async function renamePrinterPath(
  printer: Printer,
  fromPath: string,
  toPath: string
): Promise<void> {
  await withQueuedFtp(printer, async (client) => {
    await client.rename(fromPath, toPath)
    clearCachedPrinterLists(printer)
  })
}
