/**
 * Bridge runtime client: the long-lived loop that registers the bridge with the
 * PrintStream server, holds the workspace WebSocket, and serves its RPC/command
 * surface (printer monitoring, camera streams, LAN storage, library files,
 * discovery, validation, updates).
 *
 * Self-healing by design: it reconnects on every failure, clears and re-registers
 * when stored credentials are rejected, and exits (for the supervisor to restart)
 * after an accepted update. Update mechanics are delegated to a `BridgeUpdateDriver`
 * so this module stays packaging-agnostic (Docker image-pull vs standalone self-update).
 */
import { setTimeout as delay } from 'node:timers/promises'
import { readFile, stat } from 'node:fs/promises'
import WebSocket from 'ws'
import {
  bridgeCameraFrameMessageSchema,
  bridgePrinterFtpActivityMessageSchema,
  bridgePingParamsSchema,
  bridgePingResultSchema,
  bridgeSystemLogsParamsSchema,
  bridgeSystemLogsResultSchema,
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
  bridgeDebugCaptureStartParamsSchema,
  bridgeDebugCaptureStopParamsSchema,
  bridgeDebugCaptureReadParamsSchema,
  bridgeDebugCaptureReadResultSchema,
  bridgeDebugCaptureStatusResultSchema,
  createAbortError,
  type BridgeRuntimeInboundMessage,
  type Printer,
  type BridgeRuntimeRegistrationRequest,
  type BridgeRuntimeRegistrationResponse
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
import { getBridgeLogs, installBridgeLogCapture } from './bridge-logs.js'
import {
  getCaptureStatus,
  onCaptureStatusChange,
  readCapture,
  recordCaptureFrame,
  startCapture,
  stopCapture
} from './debug-capture.js'
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
import { collectBridgeMetrics, recordApiReconnect } from './bridge-metrics.js'
import { clearBridgeState, readBridgeState, writeBridgeState, type BridgeState } from './state-store.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { BridgeUpdateDriver } from './update-driver.js'
import { createImagePullUpdateDriver } from './update-driver-imagepull.js'

const RECONNECT_DELAY_MS = 5_000
/** Ceiling for the reconnect backoff, so a long outage doesn't stretch retries indefinitely. */
const MAX_RECONNECT_DELAY_MS = 60_000
/** A connection that held at least this long is treated as healthy, resetting the backoff to base. */
const SUSTAINED_CONNECTION_MS = 30_000
const CAMERA_STREAM_RETRY_DELAY_MS = 1_000
/** Drop camera frames when the API socket's send buffer exceeds this, to bound bridge memory on a slow uplink. */
const CAMERA_FRAME_MAX_BUFFERED_BYTES = 4 * 1024 * 1024
/** Delay before the first per-printer LAN connection probe, letting the persistent monitor connect first. */
const INITIAL_CONNECTION_PROBE_DELAY_MS = 45_000
/** How often the bridge re-checks each printer's LAN/developer-mode reachability. */
const CONNECTION_PROBE_INTERVAL_MS = 10 * 60_000

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
  /** Packaging-specific update mechanics; defaults to the Docker image-pull driver. */
  updateDriver?: BridgeUpdateDriver
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
  private connectionProbeTimer: ReturnType<typeof setInterval> | null = null
  private connectionProbeInitialTimer: ReturnType<typeof setTimeout> | null = null
  private readonly simulator: BridgeRuntimeSimulator | null
  private readonly updateDriver: BridgeUpdateDriver
  private statusSnapshot: BridgeRuntimeStatusSnapshot = {
    lifecycle: 'starting',
    bridgeId: null,
    connectCode: null,
    workspaceConnected: false,
    message: 'Starting bridge runtime.'
  }
  constructor(private readonly options: BridgeRuntimeClientOptions = {}) {
    // Capture console output into a ring buffer so the `system.logs` RPC can
    // surface bridge diagnostics in the web app — essential for native builds,
    // whose console output is otherwise hidden in an on-disk service log file.
    installBridgeLogCapture()
    this.simulator = options.simulator ?? null
    this.updateDriver = options.updateDriver ?? createImagePullUpdateDriver()
  }

  getStatusSnapshot(): BridgeRuntimeStatusSnapshot {
    return { ...this.statusSnapshot }
  }

  async start(): Promise<void> {
    this.updateStatus({
      lifecycle: 'starting',
      message: 'Starting bridge runtime.'
    })

    // Jittered exponential backoff so a fleet of bridges doesn't reconnect in
    // lockstep when the API restarts (each reconnect drives registration + DB
    // recovery server-side — a synchronized 5s beat is a thundering herd). The
    // delay resets to the base once a connection has held for a while.
    let reconnectDelayMs = RECONNECT_DELAY_MS
    let attempt = 0
    for (;;) {
      // Every iteration past the first is a reconnect of the bridge -> API link.
      if (attempt > 0) recordApiReconnect()
      attempt += 1
      const attemptStartedAt = Date.now()
      try {
        await this.runOnce()
      } catch (error) {
        this.reportFailure(error)
        logBridgeRuntimeFailure(error)
      }
      if (Date.now() - attemptStartedAt >= SUSTAINED_CONNECTION_MS) {
        reconnectDelayMs = RECONNECT_DELAY_MS
      }
      const jitterMs = Math.round(Math.random() * reconnectDelayMs * 0.25)
      await delay(reconnectDelayMs + jitterMs)
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS)
    }
  }

  private async runOnce(): Promise<void> {
    const state = await readBridgeState(env.BRIDGE_STATE_FILE)
    this.updateStatus({
      lifecycle: 'registering',
      bridgeId: state?.bridgeId ?? this.statusSnapshot.bridgeId,
      connectCode: null,
      workspaceConnected: false,
      message: `Registering bridge with ${env.BRIDGE_SERVER_URL}.`
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
    await this.updateDriver.confirmHealthy()

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

  /**
   * Reads the managed-bridge provisioning token from the shared mount, if
   * present. A managed server generates this file; absent it (cloud/remote
   * installs) the bridge registers without a token and pairs by connect code.
   */
  private async readManagedBridgeToken(): Promise<string | undefined> {
    try {
      const token = (await readFile(env.MANAGED_BRIDGE_TOKEN_FILE, 'utf8')).trim()
      return token || undefined
    } catch {
      return undefined
    }
  }

  private async register(state: Awaited<ReturnType<typeof readBridgeState>>): Promise<BridgeRuntimeRegistrationResponse> {
    const provisionSecret = await this.readManagedBridgeToken()
    const body: BridgeRuntimeRegistrationRequest = {
      ...(state ? { bridgeId: state.bridgeId, runtimeToken: state.runtimeToken } : {}),
      name: env.BRIDGE_NAME,
      ...(env.BRIDGE_BUILD_REVISION ? { buildRevision: env.BRIDGE_BUILD_REVISION } : {}),
      ...(env.BRIDGE_SOURCE_FINGERPRINT ? { sourceFingerprint: env.BRIDGE_SOURCE_FINGERPRINT } : {}),
      ...(env.BRIDGE_RELEASE_FINGERPRINT ? { releaseFingerprint: env.BRIDGE_RELEASE_FINGERPRINT } : {}),
      ...(provisionSecret ? { provisionSecret } : {}),
      protocolVersion: env.BRIDGE_PROTOCOL_VERSION,
      runnerAbiVersion: env.BRIDGE_RUNNER_ABI_VERSION
    }

    let response: Response
    try {
      response = await fetch(new URL('/api/bridge-runtime/register', env.BRIDGE_SERVER_URL), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    } catch (error) {
      throw new BridgeRuntimeFailure(
        'api-unavailable',
        `Bridge API at ${env.BRIDGE_SERVER_URL} is unavailable during registration${describeErrorSuffix(error)} Retrying in ${RECONNECT_DELAY_MS / 1000}s.`
      )
    }

    const payload = await readResponsePayload(response)
    if (!response.ok) {
      throw createBridgeRegistrationFailure(response, payload)
    }
    return bridgeRuntimeRegistrationResponseSchema.parse(payload)
  }

  private async connect(registration: BridgeRuntimeRegistrationResponse): Promise<void> {
    const wsUrl = buildWebSocketUrl(env.BRIDGE_SERVER_URL, registration.connectPath)
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
    // Push debug-capture status changes (start/stop/auto-stop) to the API so the
    // "capture active" banner stays live. The capture itself runs locally and
    // survives bridge↔API reconnects; only this notifier is per-connection.
    onCaptureStatusChange((status) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'bridge.debug.capture.status', status }))
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
          ...(env.BRIDGE_BUILD_REVISION ? { buildRevision: env.BRIDGE_BUILD_REVISION } : {}),
          ...(env.BRIDGE_SOURCE_FINGERPRINT ? { sourceFingerprint: env.BRIDGE_SOURCE_FINGERPRINT } : {}),
          ...(env.BRIDGE_RELEASE_FINGERPRINT ? { releaseFingerprint: env.BRIDGE_RELEASE_FINGERPRINT } : {}),
          protocolVersion: env.BRIDGE_PROTOCOL_VERSION,
          runnerAbiVersion: env.BRIDGE_RUNNER_ABI_VERSION
        })))
        heartbeatTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'bridge.heartbeat' }))
            // Piggyback a bridge-local metrics snapshot on the heartbeat cadence.
            // The API only retains it when its own metrics are enabled; otherwise
            // it is a tiny, ignored message.
            socket.send(JSON.stringify({
              type: 'bridge.metrics',
              metrics: collectBridgeMetrics({
                printersMonitored: printerMonitor.monitoredCount(),
                printersConnected: printerMonitor.connectedCount()
              })
            }))
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
          // Re-announce any in-progress capture so an API that restarted (or just
          // (re)connected) re-learns it and keeps the banner accurate.
          if (parsed.data.connected && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'bridge.debug.capture.status', status: getCaptureStatus() }))
          }
        }
      })

      socket.once('close', () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        onCaptureStatusChange(null)
        this.stopAllCameraStreams()
        stopDiscovery()
        printerMonitor.stopAll()
        this.simulator?.stop()
        console.log(`Bridge websocket disconnected by server. Reconnecting in ${RECONNECT_DELAY_MS / 1000}s.`)
        this.updateStatus({
          lifecycle: 'disconnected',
          workspaceConnected: false,
          message: `Bridge connection closed. Retrying in ${RECONNECT_DELAY_MS / 1000}s.`
        })
        resolve()
      })
      socket.once('error', (error) => {
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        onCaptureStatusChange(null)
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

      if (request.method === 'system.logs') {
        const parsed = bridgeSystemLogsParamsSchema.parse(request.params)
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: bridgeSystemLogsResultSchema.parse({
            entries: getBridgeLogs(parsed.limit)
          })
        }))
        return
      }

      if (request.method === 'debug.capture.start') {
        const params = bridgeDebugCaptureStartParamsSchema.parse(request.params)
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: bridgeDebugCaptureStatusResultSchema.parse(startCapture(params))
        }))
        return
      }

      if (request.method === 'debug.capture.stop') {
        bridgeDebugCaptureStopParamsSchema.parse(request.params)
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: bridgeDebugCaptureStatusResultSchema.parse(stopCapture('manual'))
        }))
        return
      }

      if (request.method === 'debug.capture.read') {
        bridgeDebugCaptureReadParamsSchema.parse(request.params)
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: bridgeDebugCaptureReadResultSchema.parse(readCapture())
        }))
        return
      }

      if (request.method === 'bridge.update.check') {
        bridgeUpdateCheckParamsSchema.parse(request.params)
        const result = await this.updateDriver.check()
        socket.send(JSON.stringify({
          type: 'bridge.rpc.success',
          id: request.id,
          result: bridgeUpdateActionResultSchema.parse(result)
        }))
        return
      }

      if (request.method === 'bridge.update.install') {
        bridgeUpdateInstallParamsSchema.parse(request.params)
        // Operator-initiated installs override a held-back build.
        const result = await this.updateDriver.install({ ignoreHoldBack: true })
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
      console.warn(`[bridge:rpc:${request.method}] failed: ${(error as Error).message}`)
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

  private async runAutomaticBridgeUpdate(): Promise<boolean> {
    try {
      const result = await this.updateDriver.install()
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

  private scheduleBridgeRestart(): void {
    if (this.restartScheduled) return
    this.restartScheduled = true
    setTimeout(() => process.exit(0), 500)
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

    this.scheduleConnectionProbes(socket)
  }

  private startCameraStream(socket: WebSocket, printerId: string): void {
    if (this.cameraControllers.has(printerId)) return

    const printer = this.configuredPrinters.get(printerId)
    if (!printer) return

    const controller = new AbortController()
    this.cameraControllers.set(printerId, controller)
    recordCaptureFrame({ kind: 'camera', printerId, printerName: printer.name, summary: 'camera stream started' })
    void this.pumpCameraFrames(socket, printer, controller)
  }

  private stopCameraStream(printerId: string): void {
    const controller = this.cameraControllers.get(printerId)
    if (!controller) return

    this.cameraControllers.delete(printerId)
    recordCaptureFrame({ kind: 'camera', printerId, summary: 'camera stream stopped' })
    controller.abort()
  }

  private stopAllCameraStreams(): void {
    for (const printerId of [...this.cameraControllers.keys()]) {
      this.stopCameraStream(printerId)
    }
    this.stopAllFtpActivitySubscriptions()
    this.clearConnectionProbeTimers()
    this.watchedCameraPrinterIds.clear()
    this.configuredPrinters.clear()
  }

  /**
   * (Re)schedule the periodic per-printer LAN connection probe. Runs an initial
   * probe shortly after configuration (so the persistent monitor connects first)
   * then on a long interval, pushing each result to the API so it can warn when a
   * printer is reachable but not in LAN/developer mode. Skipped in demo mode.
   */
  private scheduleConnectionProbes(socket: WebSocket): void {
    this.clearConnectionProbeTimers()
    if (this.simulator || this.configuredPrinters.size === 0) return
    this.connectionProbeInitialTimer = setTimeout(() => {
      void this.runConnectionProbes(socket)
    }, INITIAL_CONNECTION_PROBE_DELAY_MS)
    this.connectionProbeInitialTimer.unref?.()
    this.connectionProbeTimer = setInterval(() => {
      void this.runConnectionProbes(socket)
    }, CONNECTION_PROBE_INTERVAL_MS)
    this.connectionProbeTimer.unref?.()
  }

  private clearConnectionProbeTimers(): void {
    if (this.connectionProbeTimer) {
      clearInterval(this.connectionProbeTimer)
      this.connectionProbeTimer = null
    }
    if (this.connectionProbeInitialTimer) {
      clearTimeout(this.connectionProbeInitialTimer)
      this.connectionProbeInitialTimer = null
    }
  }

  private async runConnectionProbes(socket: WebSocket): Promise<void> {
    if (this.simulator) return
    for (const printer of [...this.configuredPrinters.values()]) {
      if (socket.readyState !== WebSocket.OPEN) return
      try {
        const validation = await validatePrinterLanConnection({
          host: printer.host,
          serial: printer.serial,
          accessCode: printer.accessCode
        })
        recordCaptureFrame({
          kind: 'connection',
          printerId: printer.id,
          printerName: printer.name,
          summary: `LAN probe: ok=${validation.ok} mqttReachable=${validation.mqttReachable} developerMode=${validation.developerModeEnabled}`
        })
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'bridge.printer.connection', printerId: printer.id, validation }))
        }
      } catch (error) {
        console.warn(`[bridge:printer:${printer.name}] connection probe failed`, error instanceof Error ? error.message : error)
      }
    }
  }

  private subscribeToFtpActivity(socket: WebSocket, printer: Printer): void {
    const sendActivity = (active: boolean) => {
      recordCaptureFrame({
        kind: 'ftps',
        printerId: printer.id,
        printerName: printer.name,
        summary: active ? 'FTPS transfer active' : 'FTPS transfer idle'
      })
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

            // The bridge→API hop crosses the cloud and is the slowest link. If it
            // backs up, drop this frame instead of letting `ws` queue every JPEG in
            // bridge memory (base64-inflated, unbounded → OOM on a small bridge box).
            // Live video should drop, not buffer; the next frame goes out once it drains.
            if (socket.bufferedAmount > CAMERA_FRAME_MAX_BUFFERED_BYTES) {
              continue
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
          recordCaptureFrame({
            kind: 'camera',
            printerId: printer.id,
            printerName: printer.name,
            summary: `camera stream error: ${error instanceof Error ? error.message : String(error)}`
          })
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
  if (signal.aborted) throw createAbortError('Bridge RPC cancelled')
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

