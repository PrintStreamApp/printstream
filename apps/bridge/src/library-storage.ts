/**
 * Bridge-owned library file storage on the local filesystem.
 *
 * Backs the `library.*` RPCs: whole/chunked writes, reads, stat (with sha256),
 * copy, and delete of stored library files under `BRIDGE_LIBRARY_DIR`. Stored
 * paths are flattened to their basename inside that directory
 * (`resolveBridgeLibraryPath`), so callers must pass collision-free names.
 */
import path from 'node:path'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { appendFile, copyFile, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { env } from './env.js'

export async function writeBridgeLibraryFile(storedPath: string, buffer: Buffer): Promise<void> {
  const targetPath = resolveBridgeLibraryPath(storedPath)
  await mkdir(path.dirname(targetPath), { recursive: true })
  await writeFile(targetPath, buffer)
}

export async function startBridgeLibraryFileWrite(storedPath: string): Promise<void> {
  const targetPath = resolveBridgeLibraryPath(storedPath)
  await mkdir(path.dirname(targetPath), { recursive: true })
  await writeFile(targetPath, new Uint8Array())
}

export async function appendBridgeLibraryFileChunk(storedPath: string, buffer: Buffer): Promise<void> {
  if (buffer.byteLength === 0) return
  const targetPath = resolveBridgeLibraryPath(storedPath)
  await mkdir(path.dirname(targetPath), { recursive: true })
  await appendFile(targetPath, buffer)
}

export async function readBridgeLibraryFile(storedPath: string): Promise<Buffer | null> {
  try {
    return await readFile(resolveBridgeLibraryPath(storedPath))
  } catch {
    return null
  }
}

export async function readBridgeLibraryFileChunk(storedPath: string, offset: number, maxBytes: number): Promise<{ buffer: Buffer; eof: boolean; sizeBytes: number } | null> {
  let handle
  try {
    handle = await open(resolveBridgeLibraryPath(storedPath), 'r')
    const info = await handle.stat()
    if (offset >= info.size) {
      return { buffer: Buffer.alloc(0), eof: true, sizeBytes: info.size }
    }

    const length = Math.min(maxBytes, info.size - offset)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, offset)
    return {
      buffer: buffer.subarray(0, bytesRead),
      eof: offset + bytesRead >= info.size,
      sizeBytes: info.size
    }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export async function deleteBridgeLibraryFile(storedPath: string): Promise<void> {
  await rm(resolveBridgeLibraryPath(storedPath), { force: true }).catch(() => undefined)
}

export async function locateBridgeLibraryFile(storedPath: string): Promise<string> {
  const filePath = resolveBridgeLibraryPath(storedPath)
  await stat(filePath)
  return filePath
}

export async function statBridgeLibraryFile(storedPath: string): Promise<{ sizeBytes: number; contentSha256: string }> {
  const filePath = resolveBridgeLibraryPath(storedPath)
  const info = await stat(filePath)
  return {
    sizeBytes: info.size,
    contentSha256: await hashFileContents(filePath)
  }
}

export async function copyBridgeLibraryFile(sourceStoredPath: string, targetStoredPath: string): Promise<void> {
  const sourcePath = resolveBridgeLibraryPath(sourceStoredPath)
  const targetPath = resolveBridgeLibraryPath(targetStoredPath)
  await mkdir(path.dirname(targetPath), { recursive: true })
  await copyFile(sourcePath, targetPath)
}

function resolveBridgeLibraryPath(storedPath: string): string {
  return path.join(path.resolve(env.BRIDGE_LIBRARY_DIR), path.basename(storedPath))
}

function hashFileContents(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}