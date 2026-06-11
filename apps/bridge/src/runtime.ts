import { setTimeout as delay } from 'node:timers/promises'
import { stat } from 'node:fs/promises'
import WebSocket from 'ws'
import {
  bridgeCameraFrameMessageSchema,
  bridgePrinterFtpActivityMessageSchema,
  bridgePingParamsSchema,
  bridgePingResultSchema,
  bridgeReleaseManifestSchema,
  bridgeUpdateCheckParamsSchema,
  bridgeUpdateActionResultSchema,
  bridgeUpdateInstallParamsSchema,
  bridgeLibraryCopyParamsSchema,
  bridgeCameraSnapshotParamsSchema,
  bridgeLibraryDeleteParamsSchema,
  bridgeLibraryInspect3mfParamsSchema,
  bridgeLibraryReadChunkParamsSchema,
  bridgeLibraryReadChunkResultSchema,
  bridgeLibraryStatParamsSchema,
  bridgeLibraryStatResultSchema,
  bridgeLibraryInspect3mfResultSchema,
  bridgeLibraryReadParamsSchema,
  bridgeLibraryReadThumbnailParamsSchema,
  bridgeLibraryReadThumbnailResultSchema,
  bridgePrinterValidationParamsSchema,
  bridgePrinterValidationResultSchema,
  bridgeLibraryStoreChunkParamsSchema,
  bridgeLibraryStoreStartParamsSchema,
  bridgeLibraryStoreParamsSchema,
  bridgeStorageDeleteParamsSchema,
  bridgeStorageDownloadParamsSchema,
  bridgeStorageFileSizeParamsSchema,
  bridgeStorageListParamsSchema,
  bridgeStorageUploadLibraryPlateParamsSchema,
  bridgeStorageReadZipEntriesParamsSchema,
  bridgeStorageRenameParamsSchema,
  bridgeStorageUploadLibraryParamsSchema,
  bridgeStorageUploadParamsSchema,
  bridgeRuntimeHelloMessageSchema,
  bridgeRuntimeOutboundMessageSchema,
  bridgeRuntimeRegistrationResponseSchema,
  type BridgeRuntimeInboundMessage,
  type Printer,
  type BridgeRuntimeRegistrationRequest,
  type BridgeRuntimeRegistrationResponse,
  type BridgeUpdateActionResult
} from '@printstream/shared'
import {
  deletePrinterDirectory,
  deletePrinterFile,
  downloadFileFromPrinter,
  downloadFileFromPrinterOffset,
  fetchSnapshot,
  getPrinterFileSize,
  isFtpActivityActive,
  PrinterDiscovery,
  listPrinterDirectory,
  listPrinterDirectoryRecursive,
  onFtpActivityChange,
  readRemoteZipEntries,
  renamePrinterPath,
  streamFrames,
  uploadFileToPrinterPath,
  validatePrinterLanConnection
} from '@printstream/bridge-runtime'
import { env } from './env.js'
import {
  appendBridgeLibraryFileChunk,
  copyBridgeLibraryFile,
  deleteBridgeLibraryFile,
  locateBridgeLibraryFile,
  readBridgeLibraryFile,
  readBridgeLibraryFileChunk,
  startBridgeLibraryFileWrite,
  statBridgeLibraryFile,
  writeBridgeLibraryFile
} from './library-storage.js'
import {
  createSinglePlateBridgeThreeMf,
  readBridgeLibraryThreeMfIndex,
  readBridgeLibraryThumbnail
} from './library-3mf.js'
import { BridgePrinterMonitor } from './printer-monitor.js'
import { clearBridgeState, readBridgeState, writeBridgeState, type BridgeState } from './state-store.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { activateBridgeRelease, resolveBridgeReleaseUrl, stageBridgeReleaseBundle } from './update-bundles.js'
import { cleanupConfirmedBridgeReleases, confirmActiveBridgeReleaseHealthy } from './launcher.js'

const RECONNECT_DELAY_MS = 5_000
const CAMERA_STREAM_RETRY_DELAY_MS = 1_000

type BridgeRuntimeFailureKind = 'api-unavailable' | 'invalid-credentials' | 'registration-failed' | 'connection-failed'

export type BridgeRuntimeLifecycle =
  | 'starting'
  | 'registering'
  | 'pairing'
  | 'connecting'
  | 'waiting-for-workspace'
  | 'connected'
  | 'disconnected'
  | 'error'

export interface BridgeRuntimeStatusSnapshot {
  lifecycle: BridgeRuntimeLifecycle
  bridgeId: string | null
  connectCode: string | null
  workspaceConnected: boolean
  message: string | null
}

export interface BridgeRuntimeClientOptions {
  onStatusChange?: (snapshot: BridgeRuntimeStatusSnapshot) => void
  simulator?: BridgeRuntimeSimulator | null
}

export interface BridgeRuntimeSimulator {
  start(sendMessage: (message: BridgeRuntimeInboundMessage) => void): void
  stop(): void
  updatePrinters(printers: readonly Printer[]): void
  handleCommand(message: Extract<ReturnType<typeof bridgeRuntimeOutboundMessageSchema.parse>, { type: 'bridge.command' }>): void
  handleRpcRequest(request: Extract<ReturnType<typeof bridgeRuntimeOutboundMessageSchema.parse>, { type: 'bridge.rpc.request' }>): boolean
  watchCamera(printerId: string): void
  unwatchCamera(printerId: string): void
}

export class BridgeRuntimeFailure extends Error {
  constructor(
    readonly kind: BridgeRuntimeFailureKind,
    message: string
  ) {
    super(message)
    this.name = 'BridgeRuntimeFailure'
  }
}

export class BridgeRuntimeClient {
  private readonly configuredPrinters = new Map<string, Printer>()
  private readonly watchedCameraPrinterIds = new Set<string>()
  private readonly cameraControllers = new Map<string, AbortController>()
  private readonly ftpActivityUnsubscribers = new Map<string, () => void>()
  private readonly rpcAbortControllers = new Map<string, AbortController>()
  private restartScheduled = false
  private readonly simulator: BridgeRuntimeSimulator | null
  private statusSnapshot: BridgeRuntimeStatusSnapshot = {
    lifecycle: 'starting',
    bridgeId: null,
    connectCode: null,
    workspaceConnected: false,
    message: 'Starting bridge runtime.'
  }
  constructor(private readonly options: BridgeRuntimeClientOptions = {}) {
    this.simulator = options.simulator ?? null
  }

  getStatusSnapshot(): BridgeRuntimeStatusSnapshot {
    return { ...this.statusSnapshot }
  }

  async start(): Promise<void> {
    this.updateStatus({
      lifecycle: 'starting',
      message: 'Starting bridge runtime.'
    })

    for (;;) {
      try {
        await this.runOnce()
      } catch (error) {
        this.reportFailure(error)
        logBridgeRuntimeFailure(error)
      }
      await delay(RECONNECT_DELAY_MS)
    }
  }

  private async runOnce(): Promise<void> {
    const state = await readBridgeState(env.BRIDGE_STATE_FILE)
    this.updateStatus({
      lifecycle: 'registering',
      bridgeId: state?.bridgeId ?? this.statusSnapshot.bridgeId,
      connectCode: null,
      workspaceConnected: false,
      message: `Registering bridge with ${env.BRIDGE_CLOUD_URL}.`
    })
    let registration: BridgeRuntimeRegistrationResponse
    try {
      registration = await this.register(state)
    } catch (error) {
      if (await recoverBridgeStateFromRegisterFailure(state, error, env.BRIDGE_STATE_FILE)) {
        console.warn('Stored bridge runtime credentials were rejected by the API. Clearing persisted bridge state and retrying registration as a new bridge.')
        return
      }
      throw error
    }
    await writeBridgeState(env.BRIDGE_STATE_FILE, {
      bridgeId: registration.bridge.id,
      runtimeToken: registration.runtimeToken
    })
    await this.confirmActiveBridgeReleaseHealth()

    if (env.BRIDGE_AUTO_UPDATE && await this.runAutomaticBridgeUpdate()) {
      return
    }

    this.updateStatus({
      lifecycle: registration.bridge.connectCode ? 'pairing' : 'connecting',
      bridgeId: registration.bridge.id,
      connectCode: registration.bridge.connectCode ?? null,
      workspaceConnected: false,
      message: registration.bridge.connectCode
        ? 'Bridge registered. Waiting for workspace pairing.'
        : 'Bridge registered. Connecting to workspace transport.'
    })

    if (registration.bridge.connectCode) {
      console.log(`Bridge connect code: ${registration.bridge.connectCode}`)
    }

    await this.connect(registration)
  }

  private async register(state: Awaited<ReturnType<typeof readBridgeState>>): Promise<BridgeRuntimeRegistrationResponse> {
    const body: BridgeRuntimeRegistrationRequest = {
      ...(state ? { bridgeId: state.bridgeId, runtimeToken: state.runtimeToken } : {}),
      name: env.BRIDGE_NAME,
      version: env.BRIDGE_VERSION,
      ...(env.BRIDGE_BUILD_REVISION ? { buildRevision: env.BRIDGE_BUILD_REVISION } : {}),
      ...(env.BRIDGE_SOURCE_FINGERPRINT ? { sourceFingerprint: env.BRIDGE_SOURCE_FINGERPRINT } : {}),
      protocolVersion: env.BRIDGE_PROTOCOL_VERSION,
      runnerAbiVersion: env.BRIDGE_RUNNER_ABI_VERSION,
      updateChannel: env.BRIDGE_UPDATE_CHANNEL
    }

    let response: Response
    try {
      response = await fetch(new URL('/api/bridge-runtime/register', env.BRIDGE_CLOUD_URL), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    } catch (error) {
      throw new BridgeRuntimeFailure(
        'api-unavailable',
        `Bridge API at ${env.BRIDGE_CLOUD_URL} is unavailable during registration${describeErrorSuffix(error)} Retrying in ${RECONNECT_DELAY_MS / 1000}s.`
      )
    }

    const payload = await readResponsePayload(response)
    if (!response.ok) {
      throw createBridgeRegistrationFailure(response, payload)
    }
    return bridgeRuntimeRegistrationResponseSchema.parse(payload)
  }

  private async connect(registration: BridgeRuntimeRegistrationResponse): Promise<void> {
    const wsUrl = buildWebSocketUrl(env.BRIDGE_CLOUD_URL, registration.connectPath)
    this.updateStatus({
      lifecycle: registration.bridge.connectCode ? 'pairing' : 'connecting',
      bridgeId: registration.bridge.id,
      connectCode: registration.bridge.connectCode ?? null,
      workspaceConnected: false,
      message: `Opening bridge websocket at ${wsUrl}.`
    })
    const socket = new WebSocket(wsUrl)
    let discoveryRunning = false
    const printerDiscovery = new PrinterDiscovery((printers) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'bridge.printer.discovered', printers }))
      }
    })
    const printerMonitor = new BridgePrinterMonitor((message) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message))
      }
    })
    this.simulator?.start((message) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message))
      }
    })

    await new Promise<void>((resolve, reject) => {
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null
      const startDiscovery = () => {
        if (discoveryRunning) return
        printerDiscovery.start(env.DISCOVERY_PORT)
        discoveryRunning = true
      }

      const stopDiscovery = () => {
        if (!discoveryRunning) return
        printerDiscovery.stop()
        discoveryRunning = false
      }

      socket.once('open', () => {
        socket.send(JSON.stringify(bridgeRuntimeHelloMessageSchema.parse({
          type: 'bridge.hello',
          bridgeId: registration.bridge.id,
          runtimeToken: registration.runtimeToken,
          version: env.BRIDGE_VERSION,
          ...(env.BRIDGE_BUILD_REVISION ? { buildRevision: env.BRIDGE_BUILD_REVISION } : {}),
          ...(env.BRIDGE_SOURCE_FINGERPRINT ? { sourceFingerprint: env.BRIDGE_SOURCE_FINGERPRINT } : {}),
          protocolVersion: env.BRIDGE_PROTOCOL_VERSION,
          runnerAbiVersion: env.BRIDGE_RUNNER_ABI_VERSION,
          updateChannel: env.BRIDGE_UPDATE_CHANNEL
        })))
        heartbeatTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'bridge.heartbeat' }))
          }
        }, registration.heartbeatIntervalSeconds * 1000)
      })

      socket.on('message', (data) => {
        const text = typeof data === 'string' ? data : data.toString('utf8')
        let message: unknown
        try {
          message = JSON.parse(text)
        } catch {
          return
        }
        const parsed = bridgeRuntimeOutboundMessageSchema.safeParse(message)
        if (!parsed.success) return

        if (parsed.data.type === 'bridge.rpc.request') {
          void this.handleRpcRequest(socket, parsed.data)
          return
        }

        if (parsed.data.type === 'bridge.rpc.cancel') {
          this.cancelRpcRequest(parsed.data.id)
          return
        }

        if (parsed.data.type === 'bridge.command') {
          if (this.simulator) {
            this.simulator.handleCommand(parsed.data)
          } else {
            void this.handleCommand(printerMonitor, parsed.data)
          }
          return
        }

        if (parsed.data.type === 'bridge.camera.watch') {
          this.watchedCameraPrinterIds.add(parsed.data.printerId)
          if (this.simulator) {
            this.simulator.watchCamera(parsed.data.printerId)
          } else {
            this.startCameraStream(socket, parsed.data.printerId)
          }
          return
        }

        if (parsed.data.type === 'bridge.camera.unwatch') {
          this.watchedCameraPrinterIds.delete(parsed.data.printerId)
          if (this.simulator) {
            this.simulator.unwatchCamera(parsed.data.printerId)
          } else {
            this.stopCameraStream(parsed.data.printerId)
          }
          return
        }

        if (parsed.data.type === 'bridge.printers.config') {
          this.reconcileConfiguredPrinters(parsed.data.printers, socket)
          if (this.simulator) {
            this.simulator.updatePrinters(parsed.data.printers)
          } else {
            printerMonitor.updatePrinters(parsed.data.printers)
          }
          return
        }

        if (parsed.data.type === 'bridge.welcome') {
          if (parsed.data.connected) {
            startDiscovery()
          } else {
            stopDiscovery()
          }
          this.updateStatus({
            lifecycle: parsed.data.connected ? 'connected' : 'waiting-for-workspace',
            bridgeId: parsed.data.bridgeId,
            connectCode: parsed.data.connected ? null : this.statusSnapshot.connectCode,
            workspaceConnected: parsed.data.connected,
            message: parsed.data.connected
              ? 'Connected to a PrintStream workspace.'
              : 'Waiting for a workspace to connect this bridge.'
          })
          console.log(`Bridge ${parsed.data.bridgeId} is ${parsed.data.connected ? 'connected to a workspace' : 'waiting for a workspace connection'}`)
        }
      })

      socket.once('close', () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        this.stopAllCameraStreams()
        stopDiscovery()
        printerMonitor.stopAll()
        this.simulator?.stop()
        this.updateStatus({
          lifecycle: 'disconnected',
          workspaceConnected: false,
          message: `Bridge connection closed. Retrying in ${RECONNECT_DELAY_MS / 1000}s.`
        })
        resolve()
      })
      socket.once('error', (error) => {
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        this.stopAllCameraStreams()
        stopDiscovery()
        printerMonitor.stopAll()
        this.simulator?.stop()
        reject(new BridgeRuntimeFailure(
          'connection-failed',
          `Bridge websocket connection to ${wsUrl} failed${describeErrorSuffix(error)} Retrying in ${RECONNECT_DELAY_MS / 1000}s.`
        ))
      })
    })
  }

  private updateStatus(next: Partial<BridgeRuntimeStatusSnapshot> & Pick<BridgeRuntimeStatusSnapshot, 'lifecycle'>): void {
    this.statusSnapshot = {
      ...this.statusSnapshot,
      ...next
    }
    this.options.onStatusChange?.({ ...this.statusSnapshot })
  }

  private reportFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : 'Bridge runtime failed unexpectedly.'
    this.updateStatus({
      lifecycle: 'error',
      workspaceConnected: false,
      message
    })
  }

  private async handleRpcRequest(
    socket: WebSocket,
    request: Extract<ReturnType<typeof bridgeRuntimeOutboundMessageSchema.parse>, { type: 'bridge.rpc.request' }>
  ): Promise<void> {
    const abortController = new AbortController()
    this.rpcAbortControllers.set(request.id, abortController)
    try {
      if (this.simulator?.handleRpcRequest(request)) {
        return
      }

      if (request.method === 'camera.snapshot') {
        const parsed = bridgeCameraSnapshotParamsSchema.parse(request.params)
        const frame = await fetchSnapshot(parsed.printer)
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: {
            jpegBase64: frame.toString('base64')
          }
        }))
        return
      }

      if (request.method === 'bridge.ping') {
        bridgePingParamsSchema.parse(request.params)
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: bridgePingResultSchema.parse({
            respondedAt: new Date().toISOString()
          })
        }))
        return
      }

      if (request.method === 'bridge.update.check') {
        bridgeUpdateCheckParamsSchema.parse(request.params)
        const result = await this.checkForBridgeUpdate()
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: bridgeUpdateActionResultSchema.parse(result)
        }))
        return
      }

      if (request.method === 'bridge.update.install') {
        bridgeUpdateInstallParamsSchema.parse(request.params)
        const result = await this.installBridgeUpdateBundle()
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: bridgeUpdateActionResultSchema.parse(result)
        }))
        if (result.accepted) {
          this.scheduleBridgeRestart()
        }
        return
      }

      if (request.method === 'storage.list') {
        const parsed = bridgeStorageListParamsSchema.parse(request.params)
        const entries = parsed.recursive
          ? await listPrinterDirectoryRecursive(parsed.printer, parsed.path, parsed.maxDepth)
          : await listPrinterDirectory(parsed.printer, parsed.path)
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: { entries }
        }))
        return
      }

      if (request.method === 'storage.upload') {
        const parsed = bridgeStorageUploadParamsSchema.parse(request.params)
        const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-bridge-upload-'))
        const tempFile = path.join(tempDir, 'upload.bin')
        try {
          sendBridgeRpcProgress(socket, request.id, 0, null)
          await writeFile(tempFile, Buffer.from(parsed.fileBase64, 'base64'))
          throwIfAborted(abortController.signal)
          const info = await stat(tempFile)
          const reportProgress = createBridgeRpcProgressReporter(socket, request.id, info.size)
          reportProgress(0)
          const uploadedPath = await uploadFileToPrinterPath(parsed.printer, tempFile, parsed.remotePath, reportProgress, { signal: abortController.signal })
          socket.send(JSON.stringify({
            type: 'bridge.rpc.success',
            id: request.id,
            result: { path: uploadedPath, sizeBytes: info.size }
          }))
        } finally {
          await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
        }
        return
      }

      if (request.method === 'storage.uploadLibraryFile') {
        const parsed = bridgeStorageUploadLibraryParamsSchema.parse(request.params)
        sendBridgeRpcProgress(socket, request.id, 0, null)
        const localPath = await locateBridgeLibraryFile(parsed.storedPath)
        throwIfAborted(abortController.signal)
        const info = await stat(localPath)
        const reportProgress = createBridgeRpcProgressReporter(socket, request.id, info.size)
        reportProgress(0)
        const uploadedPath = await uploadFileToPrinterPath(
          parsed.printer,
          localPath,
          parsed.remotePath,
          reportProgress,
          { signal: abortController.signal }
        )
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: { path: uploadedPath, sizeBytes: info.size }
        }))
        return
      }

      if (request.method === 'storage.uploadLibraryPlateFile') {
        const parsed = bridgeStorageUploadLibraryPlateParamsSchema.parse(request.params)
        const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-bridge-plate-'))
        const tempFile = path.join(tempDir, path.basename(parsed.remotePath))
        try {
          sendBridgeRpcProgress(socket, request.id, 0, null)
          await createSinglePlateBridgeThreeMf(await locateBridgeLibraryFile(parsed.storedPath), tempFile, parsed.plate)
          throwIfAborted(abortController.signal)
          const info = await stat(tempFile)
          const reportProgress = createBridgeRpcProgressReporter(socket, request.id, info.size)
          reportProgress(0)
          const uploadedPath = await uploadFileToPrinterPath(parsed.printer, tempFile, parsed.remotePath, reportProgress, { signal: abortController.signal })
          socket.send(JSON.stringify({
            type: 'bridge.rpc.success',
            id: request.id,
            result: { path: uploadedPath, sizeBytes: info.size }
          }))
        } finally {
          await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
        }
        return
      }

      if (request.method === 'storage.download') {
        const parsed = bridgeStorageDownloadParamsSchema.parse(request.params)
        const buffer = parsed.remotePath
          ? await downloadFileFromPrinterOffset(parsed.printer, parsed.remotePath, parsed.startAt ?? 0, undefined, {
              signal: abortController.signal,
              maxBytes: parsed.maxBytes,
              truncateAtMaxBytes: parsed.truncateAtMaxBytes
            })
          : await downloadFileFromPrinter(parsed.printer, parsed.candidates ?? [], undefined, {
              signal: abortController.signal,
              maxBytes: parsed.maxBytes,
              truncateAtMaxBytes: parsed.truncateAtMaxBytes
            })
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: {
            bufferBase64: buffer ? buffer.toString('base64') : null
          }
        }))
        return
      }

      if (request.method === 'storage.fileSize') {
        const parsed = bridgeStorageFileSizeParamsSchema.parse(request.params)
        const sizeBytes = await getPrinterFileSize(parsed.printer, parsed.remotePath, {
          signal: abortController.signal
        })
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: { sizeBytes }
        }))
        return
      }

      if (request.method === 'storage.readZipEntries') {
        const parsed = bridgeStorageReadZipEntriesParamsSchema.parse(request.params)
        const result = await readRemoteZipEntries(parsed.printer, parsed.remotePath, parsed.entryPaths, {
          signal: abortController.signal,
          tailScanBytes: parsed.tailScanBytes,
          maxSuffixBytes: parsed.maxSuffixBytes
        })
        const entriesRecord: Record<string, string> = {}
        for (const [entryPath, buffer] of result.entries) {
          entriesRecord[entryPath] = buffer.toString('base64')
        }
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: {
            entries: entriesRecord,
            remoteSize: result.remoteSize,
            bytesRead: result.bytesRead
          }
        }))
        return
      }

      if (request.method === 'storage.rename') {
        const parsed = bridgeStorageRenameParamsSchema.parse(request.params)
        await renamePrinterPath(parsed.printer, parsed.fromPath, parsed.toPath)
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: null
        }))
        return
      }

      if (request.method === 'storage.delete') {
        const parsed = bridgeStorageDeleteParamsSchema.parse(request.params)
        if (parsed.type === 'directory') {
          await deletePrinterDirectory(parsed.printer, parsed.path)
        } else {
          await deletePrinterFile(parsed.printer, parsed.path)
        }
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: null
        }))
        return
      }

      if (request.method === 'library.store') {
        const parsed = bridgeLibraryStoreParamsSchema.parse(request.params)
        await writeBridgeLibraryFile(parsed.storedPath, Buffer.from(parsed.fileBase64, 'base64'))
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: null
        }))
        return
      }

      if (request.method === 'library.storeStart') {
        const parsed = bridgeLibraryStoreStartParamsSchema.parse(request.params)
        await startBridgeLibraryFileWrite(parsed.storedPath)
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: null
        }))
        return
      }

      if (request.method === 'library.storeChunk') {
        const parsed = bridgeLibraryStoreChunkParamsSchema.parse(request.params)
        await appendBridgeLibraryFileChunk(parsed.storedPath, Buffer.from(parsed.chunkBase64, 'base64'))
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: null
        }))
        return
      }

      if (request.method === 'library.read') {
        const parsed = bridgeLibraryReadParamsSchema.parse(request.params)
        const buffer = await readBridgeLibraryFile(parsed.storedPath)
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: {
            bufferBase64: buffer ? buffer.toString('base64') : null
          }
        }))
        return
      }

      if (request.method === 'library.readChunk') {
        const parsed = bridgeLibraryReadChunkParamsSchema.parse(request.params)
        const chunk = await readBridgeLibraryFileChunk(parsed.storedPath, parsed.offset, parsed.maxBytes)
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: bridgeLibraryReadChunkResultSchema.parse({
            bufferBase64: chunk ? chunk.buffer.toString('base64') : null,
            eof: chunk?.eof ?? true,
            sizeBytes: chunk?.sizeBytes
          })
        }))
        return
      }

      if (request.method === 'library.inspect3mf') {
        const parsed = bridgeLibraryInspect3mfParamsSchema.parse(request.params)
        const index = await readBridgeLibraryThreeMfIndex(await locateBridgeLibraryFile(parsed.storedPath))
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: bridgeLibraryInspect3mfResultSchema.parse({ index })
        }))
        return
      }

      if (request.method === 'library.stat') {
        const parsed = bridgeLibraryStatParamsSchema.parse(request.params)
        const info = await statBridgeLibraryFile(parsed.storedPath)
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: bridgeLibraryStatResultSchema.parse(info)
        }))
        return
      }

      if (request.method === 'library.copy') {
        const parsed = bridgeLibraryCopyParamsSchema.parse(request.params)
        await copyBridgeLibraryFile(parsed.sourceStoredPath, parsed.targetStoredPath)
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: null
        }))
        return
      }

      if (request.method === 'library.readThumbnail') {
        const parsed = bridgeLibraryReadThumbnailParamsSchema.parse(request.params)
        const png = await readBridgeLibraryThumbnail(
          await locateBridgeLibraryFile(parsed.storedPath),
          parsed.plateIndex ?? null
        )
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: bridgeLibraryReadThumbnailResultSchema.parse({
            pngBase64: png ? png.toString('base64') : null
          })
        }))
        return
      }

      if (request.method === 'library.delete') {
        const parsed = bridgeLibraryDeleteParamsSchema.parse(request.params)
        await deleteBridgeLibraryFile(parsed.storedPath)
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: null
        }))
        return
      }

      if (request.method === 'printer.validateConnection') {
        const parsed = bridgePrinterValidationParamsSchema.parse(request.params)
        const result = await validatePrinterLanConnection(parsed)
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: bridgePrinterValidationResultSchema.parse(result)
        }))
        return
      }

      socket.send(JSON.stringify({
        type: 'bridge.rpc.error',
        id: request.id,
        error: `Unsupported bridge RPC method: ${request.method}`
      }))
    } catch (error) {
      socket.send(JSON.stringify({
        type: 'bridge.rpc.error',
        id: request.id,
        error: (error as Error).message || 'Bridge RPC failed'
      }))
    } finally {
      this.rpcAbortControllers.delete(request.id)
    }
  }

  private cancelRpcRequest(requestId: string): void {
    this.rpcAbortControllers.get(requestId)?.abort()
  }

  private async checkForBridgeUpdate(): Promise<BridgeUpdateActionResult> {
    const release = await this.loadLatestBridgeRelease()
    if (!release) {
      return { accepted: false, status: 'unknown', message: 'No bridge release is available for this channel.' }
    }
    if (release.minimumRunnerAbiVersion !== env.BRIDGE_RUNNER_ABI_VERSION) {
      return { accepted: false, status: 'runnerUpdateRequired', message: 'A newer bridge runner image is required.' }
    }
    if (compareVersion(env.BRIDGE_VERSION, release.version) >= 0) {
      return { accepted: false, status: 'current', message: 'Bridge is current.' }
    }
    return { accepted: false, status: 'updateAvailable', message: `Bridge ${release.version} is available.` }
  }

  private async installBridgeUpdateBundle(): Promise<BridgeUpdateActionResult> {
    const release = await this.loadLatestBridgeRelease()
    if (!release) {
      return { accepted: false, status: 'unknown', message: 'No bridge release is available for this channel.' }
    }
    if (release.minimumRunnerAbiVersion !== env.BRIDGE_RUNNER_ABI_VERSION) {
      return { accepted: false, status: 'runnerUpdateRequired', message: 'A newer bridge runner image is required.' }
    }
    if (compareVersion(env.BRIDGE_VERSION, release.version) >= 0) {
      return { accepted: false, status: 'current', message: 'Bridge is current.' }
    }
    if (!release.bundle) {
      return { accepted: false, status: 'updateAvailable', message: 'Bridge update metadata is available, but no app bundle is published yet.' }
    }

    const bundleUrl = resolveBridgeReleaseUrl(release.bundle.url, env.BRIDGE_CLOUD_URL)
    const response = await fetch(bundleUrl)
    if (!response.ok) {
      return { accepted: false, status: 'updateAvailable', message: `Bridge update download failed with HTTP ${response.status}.` }
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    const stagedDir = await stageBridgeReleaseBundle({
      release,
      bytes,
      publicKeyPem: env.BRIDGE_UPDATE_PUBLIC_KEY,
      releasesDir: env.BRIDGE_RELEASES_DIR
    })
    await activateBridgeRelease({
      version: release.version,
      releasesDir: env.BRIDGE_RELEASES_DIR,
      stagedDir
    })
    return { accepted: true, status: 'updateAvailable', message: `Bridge ${release.version} installed. Restarting bridge to activate it.` }
  }

  private async runAutomaticBridgeUpdate(): Promise<boolean> {
    try {
      const result = await this.installBridgeUpdateBundle()
      if (!result.accepted) {
        if (result.status !== 'current') {
          console.log(`Automatic bridge update skipped: ${result.message}`)
        }
        return false
      }
      console.log(result.message)
      this.updateStatus({
        lifecycle: 'starting',
        workspaceConnected: false,
        message: result.message
      })
      this.scheduleBridgeRestart()
      return true
    } catch (error) {
      console.warn(`Automatic bridge update failed${describeErrorSuffix(error)}`)
      return false
    }
  }

  private async confirmActiveBridgeReleaseHealth(): Promise<void> {
    if (await confirmActiveBridgeReleaseHealthy(env.BRIDGE_RELEASES_DIR, env.BRIDGE_VERSION)) {
      console.log(`Bridge release ${env.BRIDGE_VERSION} confirmed healthy.`)
    }
    const removed = await cleanupConfirmedBridgeReleases({
      releasesDir: env.BRIDGE_RELEASES_DIR,
      retentionMs: env.BRIDGE_RELEASE_RETENTION_DAYS * 24 * 60 * 60 * 1000
    })
    if (removed.length > 0) {
      console.log(`Removed old bridge releases: ${removed.join(', ')}`)
    }
  }

  private scheduleBridgeRestart(): void {
    if (this.restartScheduled) return
    this.restartScheduled = true
    setTimeout(() => process.exit(0), 500)
  }

  private async loadLatestBridgeRelease() {
    const manifestResponse = await fetch(new URL(`/api/bridge-runtime/releases/${env.BRIDGE_UPDATE_CHANNEL}`, env.BRIDGE_CLOUD_URL))
    if (!manifestResponse.ok) {
      throw new Error(`Bridge release manifest request failed with HTTP ${manifestResponse.status}`)
    }
    const manifest = bridgeReleaseManifestSchema.parse(await manifestResponse.json())
    const channel = manifest.channels[env.BRIDGE_UPDATE_CHANNEL]
    return channel?.releases.find((release) => release.version === channel.latestVersion) ?? null
  }

  private reconcileConfiguredPrinters(printers: readonly Printer[], socket: WebSocket): void {
    this.stopAllFtpActivitySubscriptions()
    this.configuredPrinters.clear()
    for (const printer of printers) {
      this.configuredPrinters.set(printer.id, printer)
      if (!this.simulator) {
        this.subscribeToFtpActivity(socket, printer)
      }
    }

    for (const printerId of [...this.cameraControllers.keys()]) {
      this.stopCameraStream(printerId)
    }

    for (const printerId of this.watchedCameraPrinterIds) {
      if (this.simulator) {
        this.simulator.watchCamera(printerId)
      } else {
        this.startCameraStream(socket, printerId)
      }
    }
  }

  private startCameraStream(socket: WebSocket, printerId: string): void {
    if (this.cameraControllers.has(printerId)) return

    const printer = this.configuredPrinters.get(printerId)
    if (!printer) return

    const controller = new AbortController()
    this.cameraControllers.set(printerId, controller)
    void this.pumpCameraFrames(socket, printer, controller)
  }

  private stopCameraStream(printerId: string): void {
    const controller = this.cameraControllers.get(printerId)
    if (!controller) return

    this.cameraControllers.delete(printerId)
    controller.abort()
  }

  private stopAllCameraStreams(): void {
    for (const printerId of [...this.cameraControllers.keys()]) {
      this.stopCameraStream(printerId)
    }
    this.stopAllFtpActivitySubscriptions()
    this.watchedCameraPrinterIds.clear()
    this.configuredPrinters.clear()
  }

  private subscribeToFtpActivity(socket: WebSocket, printer: Printer): void {
    const sendActivity = (active: boolean) => {
      if (socket.readyState !== WebSocket.OPEN) return
      socket.send(JSON.stringify(bridgePrinterFtpActivityMessageSchema.parse({
        type: 'bridge.printer.ftps.active',
        printerId: printer.id,
        active
      })))
    }

    this.ftpActivityUnsubscribers.set(printer.id, onFtpActivityChange(printer.id, sendActivity))

    if (isFtpActivityActive(printer.id)) {
      sendActivity(true)
    }
  }

  private stopAllFtpActivitySubscriptions(): void {
    for (const unsubscribe of this.ftpActivityUnsubscribers.values()) {
      unsubscribe()
    }
    this.ftpActivityUnsubscribers.clear()
  }

  private async pumpCameraFrames(socket: WebSocket, printer: Printer, controller: AbortController): Promise<void> {
    try {
      while (!controller.signal.aborted && this.watchedCameraPrinterIds.has(printer.id) && socket.readyState === WebSocket.OPEN) {
        try {
          for await (const frame of streamFrames(printer, controller.signal)) {
            if (controller.signal.aborted || !this.watchedCameraPrinterIds.has(printer.id) || socket.readyState !== WebSocket.OPEN) {
              return
            }

            socket.send(JSON.stringify(bridgeCameraFrameMessageSchema.parse({
              type: 'bridge.camera.frame',
              printerId: printer.id,
              jpegBase64: frame.toString('base64')
            })))
          }
        } catch (error) {
          if (controller.signal.aborted || !this.watchedCameraPrinterIds.has(printer.id) || socket.readyState !== WebSocket.OPEN) {
            return
          }
          console.warn(
            `[bridge:camera:${printer.id}] stream error`,
            error instanceof Error ? error.message : error
          )
        }

        try {
          await delay(CAMERA_STREAM_RETRY_DELAY_MS, undefined, { signal: controller.signal })
        } catch {
          return
        }
      }
    } finally {
      if (this.cameraControllers.get(printer.id) === controller) {
        this.cameraControllers.delete(printer.id)
      }
    }
  }

  private async handleCommand(
    printerMonitor: BridgePrinterMonitor,
    message: Extract<ReturnType<typeof bridgeRuntimeOutboundMessageSchema.parse>, { type: 'bridge.command' }>
  ): Promise<void> {
    try {
      await printerMonitor.sendCommand(message.printer, message.payload)
    } catch (error) {
      console.error(`Bridge command publish failed for ${message.printer.name}`, error)
    }
  }
}

function createBridgeRpcProgressReporter(socket: WebSocket, requestId: string, totalBytes: number): (bytesSent: number) => void {
  let lastReportedBytes = -1

  return (bytesSent) => {
    const clampedBytes = Math.max(0, Math.min(totalBytes, Math.round(bytesSent)))
    if (clampedBytes === lastReportedBytes) return
    lastReportedBytes = clampedBytes
    socket.send(JSON.stringify({
      type: 'bridge.rpc.progress',
      id: requestId,
      bytesSent: clampedBytes,
      totalBytes
    }))
  }
}

function sendBridgeRpcProgress(socket: WebSocket, requestId: string, bytesSent: number, totalBytes: number | null): void {
  socket.send(JSON.stringify({
    type: 'bridge.rpc.progress',
    id: requestId,
    bytesSent,
    totalBytes
  }))
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  const error = new Error('Bridge RPC cancelled')
  error.name = 'AbortError'
  throw error
}

function buildWebSocketUrl(baseUrl: string, connectPath: string): string {
  const url = new URL(connectPath, baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    try {
      return await response.json()
    } catch {
      return null
    }
  }

  try {
    return await response.text()
  } catch {
    return null
  }
}

export function createBridgeRegistrationFailure(response: Response, payload: unknown): BridgeRuntimeFailure {
  const structuredError = typeof payload === 'object'
    && payload !== null
    && 'error' in payload
    && typeof payload.error === 'string'
      ? payload.error.trim()
      : ''
  const textError = typeof payload === 'string' && !payload.trim().startsWith('<')
    ? payload.trim()
    : ''
  const detail = structuredError || textError || response.statusText || `HTTP ${response.status}`

  if (response.status === 401 && structuredError === 'Bridge runtime credentials are invalid.') {
    return new BridgeRuntimeFailure(
      'invalid-credentials',
      'Bridge runtime credentials are invalid.'
    )
  }

  return new BridgeRuntimeFailure(
    'registration-failed',
    `Bridge registration failed with HTTP ${response.status}: ${detail}. Retrying in ${RECONNECT_DELAY_MS / 1000}s.`
  )
}

export async function recoverBridgeStateFromRegisterFailure(
  state: BridgeState | null,
  error: unknown,
  stateFilePath: string,
  clearState: (filePath: string) => Promise<void> = clearBridgeState
): Promise<boolean> {
  if (!state || !(error instanceof BridgeRuntimeFailure) || error.kind !== 'invalid-credentials') {
    return false
  }

  await clearState(stateFilePath)
  return true
}

function logBridgeRuntimeFailure(error: unknown): void {
  if (error instanceof BridgeRuntimeFailure) {
    console.warn(error.message)
    return
  }

  if (error instanceof Error) {
    console.error('Bridge runtime connection failed', error)
    return
  }

  console.error('Bridge runtime connection failed', error)
}

function describeErrorSuffix(error: unknown): string {
  if (!(error instanceof Error) || !error.message.trim()) {
    return '.'
  }

  return `: ${error.message.trim()}.`
}

function compareVersion(left: string, right: string): number {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (delta !== 0) return delta > 0 ? 1 : -1
  }
  return 0
}

function parseVersion(version: string): number[] {
  return version.split(/[.-]/).map((part) => {
    const parsed = Number.parseInt(part, 10)
    return Number.isFinite(parsed) ? parsed : 0
  })
}