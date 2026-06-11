/**
 * Read selected ZIP entries from a printer-side archive over FTPS
 * in a single FTP session.
 *
 * The suffix-based strategy downloads the archive tail to locate the
 * ZIP central directory, then fetches only the byte ranges that
 * contain the requested entries. All reads happen within one FTP
 * connection to avoid repeated TLS handshakes.
 */
import { inflateRawSync } from 'node:zlib'
import type { Printer } from '@printstream/shared'
import { withPrinterFtpClient } from './printer-ftp.js'

const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const ZIP_EOCD_MIN_BYTES = 22
const ZIP_LOCAL_HEADER_SLACK_BYTES = 64 * 1024

interface RemoteZipDirectoryEntry {
  path: string
  compressionMethod: number
  compressedSize: number
  uncompressedSize: number
  flags: number
  localHeaderOffset: number
}

export interface ReadRemoteZipEntriesOptions {
  tailScanBytes?: number
  maxSuffixBytes?: number
  signal?: AbortSignal
}

export interface ReadRemoteZipEntriesResult {
  entries: Map<string, Buffer>
  remoteSize: number
  bytesRead: number
}

/**
 * Read selected ZIP entries from a remote archive in a single FTP
 * session. Returns the decompressed entry buffers keyed by path.
 */
export async function readRemoteZipEntries(
  printer: Printer,
  remotePath: string,
  entryPaths: string[],
  options: ReadRemoteZipEntriesOptions = {}
): Promise<ReadRemoteZipEntriesResult> {
  const tailScanBytes = options.tailScanBytes ?? 256 * 1024
  const maxSuffixBytes = options.maxSuffixBytes ?? 8 * 1024 * 1024

  return withPrinterFtpClient(printer, async (client) => {
    const remoteSize = await client.size(remotePath)
    let bytesRead = 0

    // 1. Download the tail to find EOCD + central directory
    const tailStart = Math.max(0, remoteSize - tailScanBytes)
    const tailBuffer = await downloadRange(client, remotePath, tailStart, maxSuffixBytes)
    bytesRead += tailBuffer.byteLength

    const eocd = parseZipEndOfCentralDirectory(tailBuffer, tailStart)

    // 2. Fetch central directory if it starts before our tail
    const centralDirectorySuffixSize = remoteSize - eocd.centralDirectoryOffset
    if (centralDirectorySuffixSize > maxSuffixBytes) {
      throw new Error('ZIP central directory suffix is too large for partial fetch')
    }

    let centralDirectorySuffix: Buffer
    if (eocd.centralDirectoryOffset >= tailStart) {
      centralDirectorySuffix = tailBuffer.subarray(eocd.centralDirectoryOffset - tailStart)
    } else {
      centralDirectorySuffix = await downloadRange(client, remotePath, eocd.centralDirectoryOffset, maxSuffixBytes)
      bytesRead += centralDirectorySuffix.byteLength
    }

    const directoryEntries = parseCentralDirectoryEntries(centralDirectorySuffix)

    // 3. Find requested entries in the central directory
    const requested = new Map<string, RemoteZipDirectoryEntry>()
    for (const entryPath of entryPaths) {
      const match = directoryEntries.find((entry) => entry.path === entryPath)
      if (match) requested.set(entryPath, match)
    }
    if (requested.size === 0) {
      return { entries: new Map(), remoteSize, bytesRead }
    }

    // 4. Download the data range containing all requested entries
    const earliestOffset = Math.min(...Array.from(requested.values(), (e) => e.localHeaderOffset))
    const lastRequiredOffset = Math.max(...Array.from(requested.values(), (e) => (
      e.localHeaderOffset + e.compressedSize + ZIP_LOCAL_HEADER_SLACK_BYTES
    )))
    const boundedDataSize = Math.min(remoteSize, lastRequiredOffset) - earliestOffset
    if (boundedDataSize > maxSuffixBytes) {
      throw new Error('ZIP entry range is too large for partial fetch')
    }

    const dataSuffix = await downloadRange(client, remotePath, earliestOffset, boundedDataSize)
    bytesRead += dataSuffix.byteLength

    // 5. Extract entries from the downloaded data
    const entries = new Map<string, Buffer>()
    for (const [entryPath, directoryEntry] of requested.entries()) {
      const buffer = extractZipEntryFromSuffix(dataSuffix, earliestOffset, directoryEntry)
      if (buffer) entries.set(entryPath, buffer)
    }

    return { entries, remoteSize, bytesRead }
  }, { signal: options.signal })
}

/** Download a range from an FTP file starting at `startAt`, up to `maxBytes`. */
async function downloadRange(
  client: { downloadTo(destination: import('node:stream').Writable, remotePath: string, startAt?: number): Promise<unknown> },
  remotePath: string,
  startAt: number,
  maxBytes: number
): Promise<Buffer> {
  const { Writable } = await import('node:stream')
  const chunks: Buffer[] = []
  let totalBytes = 0
  let truncated = false

  const writable = new Writable({
    write(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const remaining = maxBytes - totalBytes
      if (remaining <= 0) {
        truncated = true
        callback()
        return
      }
      if (buffer.byteLength > remaining) {
        chunks.push(buffer.subarray(0, remaining))
        totalBytes = maxBytes
        truncated = true
        callback()
        return
      }
      totalBytes += buffer.byteLength
      chunks.push(buffer)
      callback()
    }
  })

  try {
    await client.downloadTo(writable, remotePath, Math.max(0, Math.trunc(startAt)))
  } catch (err) {
    if (!truncated) throw err
  }

  return Buffer.concat(chunks)
}

// --- ZIP parsing utilities ---

function parseZipEndOfCentralDirectory(buffer: Buffer, absoluteOffset: number): { centralDirectoryOffset: number } {
  for (let index = buffer.length - ZIP_EOCD_MIN_BYTES; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) !== ZIP_EOCD_SIGNATURE) continue

    const commentLength = buffer.readUInt16LE(index + 20)
    if (index + ZIP_EOCD_MIN_BYTES + commentLength > buffer.length) continue

    const centralDirectoryOffset = buffer.readUInt32LE(index + 16)
    const totalEntries = buffer.readUInt16LE(index + 10)
    if (totalEntries === 0xffff || centralDirectoryOffset === 0xffffffff) {
      throw new Error('ZIP64 archives are not supported for printer-side partial reads')
    }

    return { centralDirectoryOffset }
  }

  throw new Error(`ZIP end-of-central-directory not found near offset ${absoluteOffset}`)
}

function parseCentralDirectoryEntries(buffer: Buffer): RemoteZipDirectoryEntry[] {
  const entries: RemoteZipDirectoryEntry[] = []
  let offset = 0

  while (offset + 46 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) break

    const flags = buffer.readUInt16LE(offset + 8)
    const compressionMethod = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const fileNameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localHeaderOffset = buffer.readUInt32LE(offset + 42)
    const nameStart = offset + 46
    const nameEnd = nameStart + fileNameLength
    if (nameEnd > buffer.length) break

    entries.push({
      path: buffer.toString('utf8', nameStart, nameEnd),
      compressionMethod,
      compressedSize,
      uncompressedSize,
      flags,
      localHeaderOffset
    })

    offset = nameEnd + extraLength + commentLength
  }

  return entries
}

function extractZipEntryFromSuffix(
  dataSuffix: Buffer,
  suffixStartOffset: number,
  entry: RemoteZipDirectoryEntry
): Buffer | null {
  const localHeaderOffset = entry.localHeaderOffset - suffixStartOffset
  if (localHeaderOffset < 0 || localHeaderOffset + 30 > dataSuffix.length) return null
  if (dataSuffix.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) return null

  const fileNameLength = dataSuffix.readUInt16LE(localHeaderOffset + 26)
  const extraLength = dataSuffix.readUInt16LE(localHeaderOffset + 28)
  const dataStart = localHeaderOffset + 30 + fileNameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > dataSuffix.length) return null

  const compressed = dataSuffix.subarray(dataStart, dataEnd)
  switch (entry.compressionMethod) {
    case 0:
      return Buffer.from(compressed)
    case 8:
      return inflateRawSync(compressed)
    default:
      throw new Error(`Unsupported ZIP compression method: ${entry.compressionMethod}`)
  }
}
