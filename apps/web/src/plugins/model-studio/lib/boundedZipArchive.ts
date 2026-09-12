/**
 * Bounded, synchronous ZIP inflation for browser workers and worker-less fallbacks.
 *
 * Owns the hostile-archive boundary before any 3MF parser sees an entry. Limits are checked from
 * both ZIP metadata and bytes actually emitted by the inflater. Input is fed incrementally so one
 * highly-compressed entry cannot allocate its entire expanded body before the running limit fires.
 */
import { Unzip, UnzipInflate, type UnzipFile } from 'fflate'

export interface ZipInflationLimits {
  maxEntries: number
  maxEntryBytes: number
  maxInflatedBytes: number
}

const INFLATE_INPUT_CHUNK_BYTES = 16 * 1024

/** Reject names whose interpretation can differ across ZIP readers or host filesystems. */
function normalizedEntryKey(name: string): string {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[a-z]:/i.test(name)) {
    throw new Error('Archive contains an unsafe entry name')
  }
  const segments = name.split('/')
  if (segments.includes('..')) throw new Error('Archive contains an unsafe entry name')
  return segments.filter((segment) => segment !== '.').join('/').toLowerCase()
}

/** Join one entry only after its final size has been checked. */
function joinChunks(chunks: Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]?.byteLength === size) return chunks[0]
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

/** Inflate a ZIP under entry-count, per-entry, aggregate, duplicate-name, and path-name limits. */
export function boundedUnzipArchive(
  bytes: Uint8Array,
  limits: ZipInflationLimits
): Record<string, Uint8Array> {
  const entries: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>
  const names = new Set<string>()
  let entryCount = 0
  let completedEntries = 0
  let declaredBytes = 0
  let inflatedBytes = 0
  let failure: Error | null = null

  const fail = (message: string, file?: UnzipFile): never => {
    file?.terminate()
    failure = new Error(message)
    throw failure
  }

  const unzip = new Unzip((file) => {
    entryCount += 1
    if (entryCount > limits.maxEntries) fail('Archive has too many entries', file)

    const key = normalizedEntryKey(file.name)
    if (names.has(key)) fail('Archive contains duplicate entry names', file)
    names.add(key)

    if (file.originalSize != null) {
      if (file.originalSize > limits.maxEntryBytes) fail('Archive entry expands beyond the allowed size', file)
      declaredBytes += file.originalSize
      if (declaredBytes > limits.maxInflatedBytes) fail('Archive expands beyond the allowed size', file)
    }

    const chunks: Uint8Array[] = []
    let entryBytes = 0
    file.ondata = (error, chunk, final) => {
      if (error) fail(error.message, file)
      entryBytes += chunk.byteLength
      inflatedBytes += chunk.byteLength
      if (entryBytes > limits.maxEntryBytes) fail('Archive entry expands beyond the allowed size', file)
      if (inflatedBytes > limits.maxInflatedBytes) fail('Archive expands beyond the allowed size', file)
      if (chunk.byteLength > 0) chunks.push(chunk)
      if (final) {
        entries[file.name] = joinChunks(chunks, entryBytes)
        completedEntries += 1
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)

  for (let offset = 0; offset < bytes.byteLength; offset += INFLATE_INPUT_CHUNK_BYTES) {
    if (failure) throw failure
    const end = Math.min(bytes.byteLength, offset + INFLATE_INPUT_CHUNK_BYTES)
    unzip.push(bytes.subarray(offset, end), end === bytes.byteLength)
  }
  if (bytes.byteLength === 0) unzip.push(bytes, true)
  if (failure) throw failure
  if (entryCount === 0 || completedEntries !== entryCount) throw new Error('Archive is incomplete or contains no entries')
  return entries
}
