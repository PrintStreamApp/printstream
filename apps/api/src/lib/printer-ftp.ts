import { readFile } from 'node:fs/promises'
import type { Writable } from 'node:stream'
import type { BridgeStorageUploadResult, Printer } from '@printstream/shared'
import {
	bridgeStorageDeleteParamsSchema,
	bridgeStorageDownloadResultSchema,
	bridgeStorageFileSizeResultSchema,
	bridgeStorageListResultSchema,
	bridgeStorageReadZipEntriesResultSchema,
	bridgeStorageUploadLibraryPlateParamsSchema,
	bridgeStorageUploadResultSchema
} from '@printstream/shared'
import type { PrinterFsEntry } from '@printstream/bridge-runtime'
import { bridgeSessionManager } from './bridge-session-manager.js'
import { rootPrisma } from './prisma.js'

export type { PrinterFsEntry }

export interface BridgeUploadResult {
	path: string
	sizeBytes: number | null
}

type BridgeUploadProgressCallback = (bytesSent: number, totalBytes: number | null) => void

/**
 * Maximum file size for base64-encoded WS RPC transfers. Files larger
 * than this should use the bridge library path (`uploadBridgeLibraryFileToPrinterPath`)
 * so the bridge reads from its local filesystem instead of receiving
 * the payload over the WebSocket.
 */
const MAX_RPC_UPLOAD_BYTES = 50 * 1024 * 1024
const BRIDGE_STORAGE_UPLOAD_TIMEOUT_MS = 30 * 60_000
const BRIDGE_STORAGE_DOWNLOAD_TIMEOUT_MS = 5 * 60_000

/** Maximum bytes per chunk when streaming a file from the printer via bridge RPC. */
const STREAM_CHUNK_BYTES = 1024 * 1024

interface PrinterFtpOptions {
	signal?: AbortSignal
	maxBytes?: number
	truncateAtMaxBytes?: boolean
}

export async function uploadFileToPrinter(
	printer: Printer,
	localPath: string,
	remoteFilename: string,
	onProgress?: (bytesSent: number) => void,
	_options: PrinterFtpOptions = {}
): Promise<string> {
	await requireBridgeId(printer.id)
	const uploaded = await uploadFileToPrinterPath(printer, localPath, `/${remoteFilename.replace(/^\/+/, '')}`, onProgress)
	return uploaded.replace(/^\/+/, '')
}

export async function uploadFileToPrinterPath(
	printer: Printer,
	localPath: string,
	remotePath: string,
	onProgress?: (bytesSent: number) => void,
	_options: PrinterFtpOptions = {}
): Promise<string> {
	const bridgeId = await requireBridgeId(printer.id)
	const fileBuffer = await readFile(localPath)
	if (fileBuffer.byteLength > MAX_RPC_UPLOAD_BYTES) {
		throw new Error(
			`File is too large for RPC upload (${fileBuffer.byteLength} bytes). ` +
			'Use bridge library storage for large files.'
		)
	}
	const result = bridgeStorageUploadResultSchema.parse(await requestBridgeRpc(bridgeId, 'storage.upload', {
		printer,
		remotePath,
		fileBase64: fileBuffer.toString('base64')
	}, undefined, {
		timeoutMs: BRIDGE_STORAGE_UPLOAD_TIMEOUT_MS,
		...(onProgress ? { onProgress: (bytesSent: number) => onProgress(bytesSent) } : {})
	}))
	onProgress?.(fileBuffer.byteLength)
	return result.path
}

export async function uploadBridgeLibraryFileToPrinterPath(
	printer: Printer,
	storedPath: string,
	remotePath: string,
	onProgress?: BridgeUploadProgressCallback
): Promise<BridgeUploadResult> {
	const bridgeId = await requireBridgeId(printer.id)
	const result = bridgeStorageUploadResultSchema.parse(await requestBridgeRpc(bridgeId, 'storage.uploadLibraryFile', {
		printer,
		remotePath,
		storedPath
	}, undefined, {
		timeoutMs: BRIDGE_STORAGE_UPLOAD_TIMEOUT_MS,
		...(onProgress ? { onProgress } : {})
	}))
	const normalized = normalizeBridgeUploadResult(result)
	onProgress?.(normalized.sizeBytes ?? 0, normalized.sizeBytes)
	return normalized
}

export async function uploadBridgeLibraryPlateToPrinterPath(
	printer: Printer,
	storedPath: string,
	plate: number,
	remotePath: string,
	onProgress?: BridgeUploadProgressCallback
): Promise<BridgeUploadResult> {
	const bridgeId = await requireBridgeId(printer.id)
	const params = bridgeStorageUploadLibraryPlateParamsSchema.parse({
		printer,
		storedPath,
		plate,
		remotePath
	})
	// Plate extraction plus printer upload can legitimately take longer than the
	// default RPC deadline, even when the source 3MF only contains one plate.
	const result = bridgeStorageUploadResultSchema.parse(await requestBridgeRpc(bridgeId, 'storage.uploadLibraryPlateFile', params, undefined, {
		timeoutMs: BRIDGE_STORAGE_UPLOAD_TIMEOUT_MS,
		...(onProgress ? { onProgress } : {})
	}))
	const normalized = normalizeBridgeUploadResult(result)
	onProgress?.(normalized.sizeBytes ?? 0, normalized.sizeBytes)
	return normalized
}

function normalizeBridgeUploadResult(result: BridgeStorageUploadResult): BridgeUploadResult {
	return {
		path: result.path,
		sizeBytes: typeof result.sizeBytes === 'number' ? result.sizeBytes : null
	}
}

export async function downloadFileFromPrinter(
	printer: Printer,
	candidates: string[],
	onProgress?: (bytesReceived: number) => void,
	options: PrinterFtpOptions = {}
): Promise<Buffer | null> {
	const bridgeId = await requireBridgeId(printer.id)
	const result = bridgeStorageDownloadResultSchema.parse(await requestBridgeRpc(bridgeId, 'storage.download', {
		printer,
		candidates,
		maxBytes: options.maxBytes,
		truncateAtMaxBytes: options.truncateAtMaxBytes
	}, options.signal, {
		timeoutMs: BRIDGE_STORAGE_DOWNLOAD_TIMEOUT_MS
	}))
	const buffer = result.bufferBase64 ? Buffer.from(result.bufferBase64, 'base64') : null
	if (buffer) onProgress?.(buffer.byteLength)
	return buffer
}

export async function streamFileFromPrinter(
	printer: Printer,
	remotePath: string,
	writable: Writable,
	onProgress?: (bytesReceived: number) => void,
	options: PrinterFtpOptions = {}
): Promise<void> {
	const bridgeId = await requireBridgeId(printer.id)

	// Stream in bounded chunks to avoid buffering the entire file as base64.
	const fileSize = bridgeStorageFileSizeResultSchema.parse(
		await requestBridgeRpc(bridgeId, 'storage.fileSize', { printer, remotePath }, options.signal)
	).sizeBytes
	const maxBytes = options.maxBytes ?? fileSize
	const chunkSize = STREAM_CHUNK_BYTES
	let offset = 0
	let totalWritten = 0

	while (offset < fileSize && totalWritten < maxBytes) {
		const remaining = maxBytes - totalWritten
		const thisChunk = Math.min(chunkSize, remaining)
		const result = bridgeStorageDownloadResultSchema.parse(
			await requestBridgeRpc(bridgeId, 'storage.download', {
				printer,
				remotePath,
				startAt: offset,
				maxBytes: thisChunk,
				truncateAtMaxBytes: true
			}, options.signal)
		)
		if (!result.bufferBase64) {
			if (offset === 0) throw new Error('File not found')
			break
		}
		const chunk = Buffer.from(result.bufferBase64, 'base64')
		if (chunk.byteLength === 0) break

		// Respect backpressure from the writable stream
		const canContinue = writable.write(chunk)
		if (!canContinue) {
			await new Promise<void>((resolve) => writable.once('drain', resolve))
		}

		offset += chunk.byteLength
		totalWritten += chunk.byteLength
		onProgress?.(totalWritten)
	}

	writable.end()
}

export async function getPrinterFileSize(
	printer: Printer,
	remotePath: string,
	options: PrinterFtpOptions = {}
): Promise<number> {
	const bridgeId = await requireBridgeId(printer.id)
	const result = bridgeStorageFileSizeResultSchema.parse(await requestBridgeRpc(bridgeId, 'storage.fileSize', {
		printer,
		remotePath
	}, options.signal))
	return result.sizeBytes
}

export async function downloadFileFromPrinterOffset(
	printer: Printer,
	remotePath: string,
	startAt: number,
	onProgress?: (bytesReceived: number) => void,
	options: PrinterFtpOptions = {}
): Promise<Buffer> {
	const bridgeId = await requireBridgeId(printer.id)
	const result = bridgeStorageDownloadResultSchema.parse(await requestBridgeRpc(bridgeId, 'storage.download', {
		printer,
		remotePath,
		startAt,
		maxBytes: options.maxBytes,
		truncateAtMaxBytes: options.truncateAtMaxBytes
	}, options.signal, {
		timeoutMs: BRIDGE_STORAGE_DOWNLOAD_TIMEOUT_MS
	}))
	if (!result.bufferBase64) {
		throw new Error('File not found')
	}
	const buffer = Buffer.from(result.bufferBase64, 'base64')
	onProgress?.(buffer.byteLength)
	return buffer
}

export async function listPrinterDirectory(
	printer: Printer,
	dir = '/',
	options: PrinterFtpOptions = {}
): Promise<PrinterFsEntry[]> {
	const bridgeId = await requireBridgeId(printer.id)
	const result = bridgeStorageListResultSchema.parse(await requestBridgeRpc(bridgeId, 'storage.list', {
		printer,
		path: dir,
		recursive: false
	}, options.signal))
	return result.entries
}

export async function listPrinterDirectoryRecursive(
	printer: Printer,
	dir = '/',
	maxDepth = 4,
	skipDirectories: ReadonlySet<string> = new Set(),
	options: PrinterFtpOptions = {}
): Promise<PrinterFsEntry[]> {
	const bridgeId = await requireBridgeId(printer.id)
	const result = bridgeStorageListResultSchema.parse(await requestBridgeRpc(bridgeId, 'storage.list', {
		printer,
		path: dir,
		recursive: true,
		maxDepth
	}, options.signal))
	return result.entries.filter((entry) => !(entry.type === 'directory' && skipDirectories.has(entry.name)))
}

export interface ReadZipEntriesResult {
	entries: Record<string, string>
	remoteSize: number
	bytesRead: number
}

/** Read selected ZIP entries via a single bridge-side FTP session. */
export async function readPrinterZipEntries(
	printer: Printer,
	remotePath: string,
	entryPaths: string[],
	options: { tailScanBytes?: number; maxSuffixBytes?: number; signal?: AbortSignal } = {}
): Promise<ReadZipEntriesResult> {
	const bridgeId = await requireBridgeId(printer.id)
	const result = bridgeStorageReadZipEntriesResultSchema.parse(
		await requestBridgeRpc(bridgeId, 'storage.readZipEntries', {
			printer,
			remotePath,
			entryPaths,
			tailScanBytes: options.tailScanBytes,
			maxSuffixBytes: options.maxSuffixBytes
		}, options.signal)
	)
	return result
}

export async function renamePrinterPath(
	printer: Printer,
	fromPath: string,
	toPath: string,
	_options: PrinterFtpOptions = {}
): Promise<void> {
	const bridgeId = await requireBridgeId(printer.id)
	await requestBridgeRpc(bridgeId, 'storage.rename', {
		printer,
		fromPath,
		toPath
	})
}

export async function deletePrinterFile(printer: Printer, path: string, _options: PrinterFtpOptions = {}): Promise<void> {
	const bridgeId = await requireBridgeId(printer.id)
	await requestBridgeRpc(bridgeId, 'storage.delete', bridgeStorageDeleteParamsSchema.parse({
		printer,
		path,
		type: 'file'
	}))
}

export async function deletePrinterDirectory(printer: Printer, path: string, _options: PrinterFtpOptions = {}): Promise<void> {
	const bridgeId = await requireBridgeId(printer.id)
	await requestBridgeRpc(bridgeId, 'storage.delete', bridgeStorageDeleteParamsSchema.parse({
		printer,
		path,
		type: 'directory'
	}))
}

async function resolveBridgeId(printerId: string): Promise<string | null> {
	const row = await rootPrisma.printer.findUnique({
		where: { id: printerId },
		select: { bridgeId: true }
	})
	return row?.bridgeId ?? null
}

async function requireBridgeId(printerId: string): Promise<string> {
	const bridgeId = await resolveBridgeId(printerId)
	if (!bridgeId) {
		throw new Error('Printer storage access requires a connected bridge assignment')
	}
	return bridgeId
}

async function requestBridgeRpc(
	bridgeId: string,
	method: string,
	params: unknown,
	signal?: AbortSignal,
	options: {
		timeoutMs?: number
		onProgress?: (bytesSent: number, totalBytes: number | null) => void
	} = {}
): Promise<unknown> {
	if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
	if (!bridgeSessionManager.isConnected(bridgeId)) {
		throw new Error('Bridge is not connected')
	}
	if (!signal) {
		return bridgeSessionManager.requestRpc(bridgeId, method, params, options)
	}
	const { requestId, promise: rpcPromise } = bridgeSessionManager.startRpcRequest(bridgeId, method, params, options)

	return await new Promise<unknown>((resolve, reject) => {
		const onAbort = () => {
			bridgeSessionManager.cancelRpcRequest(requestId)
			reject(new DOMException('The operation was aborted', 'AbortError'))
		}
		signal.addEventListener('abort', onAbort, { once: true })
		rpcPromise
			.then((value) => { signal.removeEventListener('abort', onAbort); resolve(value) })
			.catch((error) => { signal.removeEventListener('abort', onAbort); reject(error) })
	})
}
