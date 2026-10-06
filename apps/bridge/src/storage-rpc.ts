/**
 * Validated printer-storage RPC operations served by the bridge.
 *
 * The runtime owns request ids, socket replies, and abort-controller cleanup.
 * This module owns FTP work, temporary upload files, and byte progress. Uploads
 * receive the runtime's signal so cancellation reaches the transport.
 */
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  bridgeStorageDeleteParamsSchema,
  bridgeStorageDownloadParamsSchema,
  bridgeStorageFileSizeParamsSchema,
  bridgeStorageListParamsSchema,
  bridgeStorageReadZipEntriesParamsSchema,
  bridgeStorageRenameParamsSchema,
  bridgeStorageUploadLibraryPlateParamsSchema,
  bridgeStorageUploadLibraryParamsSchema,
  bridgeStorageUploadParamsSchema,
  createAbortError
} from '@printstream/shared'
import {
  deletePrinterDirectory,
  deletePrinterFile,
  downloadFileFromPrinter,
  downloadFileFromPrinterOffset,
  getPrinterFileSize,
  listPrinterDirectory,
  listPrinterDirectoryRecursive,
  readRemoteZipEntries,
  renamePrinterPath,
  uploadFileToPrinterPath
} from '@printstream/bridge-runtime'
import { createSinglePlateBridgeThreeMf } from './library-3mf.js'
import { locateBridgeLibraryFile } from './library-storage.js'

type StorageRpcResult = { handled: true; result: unknown } | { handled: false }

type ProgressReporter = (bytesSent: number, totalBytes: number | null) => void

/**
 * Handle a printer-storage RPC, or return unhandled for another method family.
 * `signal` cancels FTP operations and is checked after local upload preparation.
 */
export async function handleStorageRpc(
  method: string,
  params: unknown,
  signal: AbortSignal,
  reportProgress: ProgressReporter
): Promise<StorageRpcResult> {
  switch (method) {
    case 'storage.list': {
      const parsed = bridgeStorageListParamsSchema.parse(params)
      const entries = parsed.recursive
        ? await listPrinterDirectoryRecursive(parsed.printer, parsed.path, parsed.maxDepth)
        : await listPrinterDirectory(parsed.printer, parsed.path)
      return { handled: true, result: { entries } }
    }
    case 'storage.upload': {
      const parsed = bridgeStorageUploadParamsSchema.parse(params)
      const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-bridge-upload-'))
      const tempFile = path.join(tempDir, 'upload.bin')
      try {
        reportProgress(0, null)
        await writeFile(tempFile, Buffer.from(parsed.fileBase64, 'base64'))
        throwIfAborted(signal)
        const info = await stat(tempFile)
        const progress = createProgressReporter(info.size, reportProgress)
        progress(0)
        const uploadedPath = await uploadFileToPrinterPath(parsed.printer, tempFile, parsed.remotePath, progress, { signal })
        return { handled: true, result: { path: uploadedPath, sizeBytes: info.size } }
      } finally {
        await removeTemporaryUpload(tempDir)
      }
    }
    case 'storage.uploadLibraryFile': {
      const parsed = bridgeStorageUploadLibraryParamsSchema.parse(params)
      reportProgress(0, null)
      const localPath = await locateBridgeLibraryFile(parsed.storedPath)
      throwIfAborted(signal)
      const info = await stat(localPath)
      const progress = createProgressReporter(info.size, reportProgress)
      progress(0)
      const uploadedPath = await uploadFileToPrinterPath(
        parsed.printer,
        localPath,
        parsed.remotePath,
        progress,
        { signal }
      )
      return { handled: true, result: { path: uploadedPath, sizeBytes: info.size } }
    }
    case 'storage.uploadLibraryPlateFile': {
      const parsed = bridgeStorageUploadLibraryPlateParamsSchema.parse(params)
      const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-bridge-plate-'))
      const tempFile = path.join(tempDir, path.basename(parsed.remotePath))
      try {
        reportProgress(0, null)
        await createSinglePlateBridgeThreeMf(await locateBridgeLibraryFile(parsed.storedPath), tempFile, parsed.plate)
        throwIfAborted(signal)
        const info = await stat(tempFile)
        const progress = createProgressReporter(info.size, reportProgress)
        progress(0)
        const uploadedPath = await uploadFileToPrinterPath(parsed.printer, tempFile, parsed.remotePath, progress, { signal })
        return { handled: true, result: { path: uploadedPath, sizeBytes: info.size } }
      } finally {
        await removeTemporaryUpload(tempDir)
      }
    }
    case 'storage.download': {
      const parsed = bridgeStorageDownloadParamsSchema.parse(params)
      const buffer = parsed.remotePath
        ? await downloadFileFromPrinterOffset(parsed.printer, parsed.remotePath, parsed.startAt ?? 0, undefined, {
            signal,
            maxBytes: parsed.maxBytes,
            truncateAtMaxBytes: parsed.truncateAtMaxBytes
          })
        : await downloadFileFromPrinter(parsed.printer, parsed.candidates ?? [], undefined, {
            signal,
            maxBytes: parsed.maxBytes,
            truncateAtMaxBytes: parsed.truncateAtMaxBytes
          })
      return { handled: true, result: { bufferBase64: buffer ? buffer.toString('base64') : null } }
    }
    case 'storage.fileSize': {
      const parsed = bridgeStorageFileSizeParamsSchema.parse(params)
      const sizeBytes = await getPrinterFileSize(parsed.printer, parsed.remotePath, { signal })
      return { handled: true, result: { sizeBytes } }
    }
    case 'storage.readZipEntries': {
      const parsed = bridgeStorageReadZipEntriesParamsSchema.parse(params)
      const result = await readRemoteZipEntries(parsed.printer, parsed.remotePath, parsed.entryPaths, {
        signal,
        tailScanBytes: parsed.tailScanBytes,
        maxSuffixBytes: parsed.maxSuffixBytes
      })
      const entriesRecord: Record<string, string> = {}
      for (const [entryPath, buffer] of result.entries) {
        entriesRecord[entryPath] = buffer.toString('base64')
      }
      return {
        handled: true,
        result: { entries: entriesRecord, remoteSize: result.remoteSize, bytesRead: result.bytesRead }
      }
    }
    case 'storage.rename': {
      const parsed = bridgeStorageRenameParamsSchema.parse(params)
      await renamePrinterPath(parsed.printer, parsed.fromPath, parsed.toPath)
      return { handled: true, result: null }
    }
    case 'storage.delete': {
      const parsed = bridgeStorageDeleteParamsSchema.parse(params)
      if (parsed.type === 'directory') {
        await deletePrinterDirectory(parsed.printer, parsed.path)
      } else {
        await deletePrinterFile(parsed.printer, parsed.path)
      }
      return { handled: true, result: null }
    }
    default:
      return { handled: false }
  }
}

/** Keep progress monotonic and avoid duplicate socket updates from FTP callbacks. */
function createProgressReporter(totalBytes: number, reportProgress: ProgressReporter): (bytesSent: number) => void {
  let lastReportedBytes = -1

  return (bytesSent) => {
    const clampedBytes = Math.max(0, Math.min(totalBytes, Math.round(bytesSent)))
    if (clampedBytes === lastReportedBytes) return
    lastReportedBytes = clampedBytes
    reportProgress(clampedBytes, totalBytes)
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw createAbortError('Bridge RPC cancelled')
}

/** Cleanup failure should not replace the upload outcome, but remains observable. */
async function removeTemporaryUpload(tempDir: string): Promise<void> {
  try {
    await rm(tempDir, { recursive: true, force: true })
  } catch (error) {
    console.warn(`Bridge storage upload cleanup failed for ${tempDir}`, error)
  }
}
