/**
 * In-memory bridge session registry.
 *
 * Tracks the single active outbound connection for each bridge, handles
 * request/response correlation for RPC calls, and caches printer status
 * snapshots reported by the bridge runtime.
 */
import { randomUUID } from 'node:crypto'
import type { Printer, PrinterStatus } from '@printstream/shared'
import type { BridgeRuntimeOutboundMessage } from '@printstream/shared'
import { bridgeUnavailableMessage } from './managed-bridge.js'

interface BridgeConnection {
  bridgeId: string
  tenantId: string | null
  send(message: BridgeRuntimeOutboundMessage): void
  close(code?: number, reason?: string): void
}

interface ActiveBridgeConnection {
  connection: BridgeConnection
  connectedAt: Date
}

interface PendingRpcRequest {
  bridgeId: string
  method: string
  timeoutMs: number
  timer: ReturnType<typeof setTimeout>
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  onProgress?: (bytesSent: number, totalBytes: number | null) => void
}

interface CameraFrameListener {
  onFrame(frame: Buffer): void
  onClose(error: Error): void
}

const BRIDGE_RPC_TIMEOUT_MS = 15_000

class BridgeSessionManager {
  private readonly connections = new Map<string, ActiveBridgeConnection>()
  private readonly pendingRequests = new Map<string, PendingRpcRequest>()
  private readonly printerStatuses = new Map<string, { bridgeId: string; status: PrinterStatus }>()
  private readonly printerFtpActivity = new Map<string, { bridgeId: string }>()
  private readonly cameraListeners = new Map<string, Map<string, Set<CameraFrameListener>>>()

  registerConnection(connection: BridgeConnection): void {
    const existing = this.connections.get(connection.bridgeId)
    if (existing) {
      existing.connection.close(4009, 'replaced by newer bridge session')
    }
    this.connections.set(connection.bridgeId, {
      connection,
      connectedAt: new Date()
    })
  }

  /**
   * Whether `connection` is the currently-registered session for `bridgeId`.
   * A closing socket uses this to tell a genuine disconnect from a reconnect/
   * duplicate that a newer session has already replaced — in the latter case the
   * bridge id now belongs to the live session and its teardown must be skipped.
   */
  isActiveConnection(bridgeId: string, connection?: BridgeConnection): boolean {
    const current = this.connections.get(bridgeId)
    if (!current) return false
    return !connection || current.connection === connection
  }

  unregisterConnection(bridgeId: string, connection?: BridgeConnection): void {
    const current = this.connections.get(bridgeId)
    if (connection && current && current.connection !== connection) {
      return
    }

    this.connections.delete(bridgeId)
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.bridgeId !== bridgeId) continue
      clearTimeout(pending.timer)
      pending.reject(new Error('Bridge session disconnected'))
      this.pendingRequests.delete(requestId)
    }
    this.failCameraListeners(bridgeId, new Error('Bridge session disconnected'))
    this.clearBridgePrinterFtpActivity(bridgeId)
  }

  isConnected(bridgeId: string): boolean {
    return this.connections.has(bridgeId)
  }

  /** Number of bridges with a live session right now (for metrics/diagnostics). */
  size(): number {
    return this.connections.size
  }

  setTenantId(bridgeId: string, tenantId: string | null): boolean {
    const activeConnection = this.connections.get(bridgeId)
    if (!activeConnection) return false
    activeConnection.connection.tenantId = tenantId
    return true
  }

  sendMessage(bridgeId: string, message: BridgeRuntimeOutboundMessage): boolean {
    const activeConnection = this.connections.get(bridgeId)
    if (!activeConnection) return false

    try {
      activeConnection.connection.send(message)
      return true
    } catch {
      return false
    }
  }

  sendCommand(bridgeId: string, printer: Printer, payload: Record<string, unknown>): boolean {
    return this.sendMessage(bridgeId, {
      type: 'bridge.command',
      printer,
      payload
    })
  }

  startRpcRequest<T>(
    bridgeId: string,
    method: string,
    params: unknown,
    options: {
      timeoutMs?: number
      onProgress?: (bytesSent: number, totalBytes: number | null) => void
    } = {}
  ): { requestId: string; promise: Promise<T> } {
    const activeConnection = this.connections.get(bridgeId)
    if (!activeConnection) {
      throw new Error(bridgeUnavailableMessage())
    }

    const requestId = randomUUID()
    const timeoutMs = options.timeoutMs ?? BRIDGE_RPC_TIMEOUT_MS
    const promise = new Promise<T>((resolve, reject) => {
      const pending: PendingRpcRequest = {
        bridgeId,
        method,
        timeoutMs,
        timer: setTimeout(() => this.timeoutRpcRequest(requestId), timeoutMs),
        resolve: (value) => {
          resolve(value as T)
        },
        reject,
        onProgress: options.onProgress
      }
      this.pendingRequests.set(requestId, pending)

      activeConnection.connection.send({
        type: 'bridge.rpc.request',
        id: requestId,
        method,
        params
      })
    })

    return { requestId, promise }
  }

  async requestRpc<T>(
    bridgeId: string,
    method: string,
    params: unknown,
    options: {
      timeoutMs?: number
      onProgress?: (bytesSent: number, totalBytes: number | null) => void
    } = {}
  ): Promise<T> {
    return await this.startRpcRequest<T>(bridgeId, method, params, options).promise
  }

  cancelRpcRequest(requestId: string): void {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingRequests.delete(requestId)
    this.sendMessage(pending.bridgeId, {
      type: 'bridge.rpc.cancel',
      id: requestId
    })
    pending.reject(new Error(`Bridge RPC cancelled: ${pending.method}`))
  }

  subscribeCameraFrames(bridgeId: string, printerId: string, listener: CameraFrameListener): () => void {
    if (!this.connections.has(bridgeId)) {
      throw new Error(bridgeUnavailableMessage())
    }

    let bridgeListeners = this.cameraListeners.get(bridgeId)
    if (!bridgeListeners) {
      bridgeListeners = new Map<string, Set<CameraFrameListener>>()
      this.cameraListeners.set(bridgeId, bridgeListeners)
    }

    let printerListeners = bridgeListeners.get(printerId)
    const firstListener = !printerListeners
    if (!printerListeners) {
      printerListeners = new Set<CameraFrameListener>()
      bridgeListeners.set(printerId, printerListeners)
    }
    printerListeners.add(listener)

    if (firstListener) {
      const sent = this.sendMessage(bridgeId, {
        type: 'bridge.camera.watch',
        printerId
      })
      if (!sent) {
        printerListeners.delete(listener)
        if (printerListeners.size === 0) {
          bridgeListeners.delete(printerId)
        }
        if (bridgeListeners.size === 0) {
          this.cameraListeners.delete(bridgeId)
        }
        throw new Error(bridgeUnavailableMessage())
      }
    }

    let active = true
    return () => {
      if (!active) return
      active = false
      this.unsubscribeCameraFrames(bridgeId, printerId, listener)
    }
  }

  handleCameraFrame(bridgeId: string, printerId: string, jpegBase64: string): void {
    const listeners = this.cameraListeners.get(bridgeId)?.get(printerId)
    if (!listeners || listeners.size === 0) return

    const frame = Buffer.from(jpegBase64, 'base64')
    for (const listener of listeners) {
      listener.onFrame(frame)
    }
  }

  resolveRpcSuccess(requestId: string, result: unknown): void {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingRequests.delete(requestId)
    pending.resolve(result)
  }

  resolveRpcProgress(requestId: string, bytesSent: number, totalBytes: number | null): void {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) return
    this.resetRpcTimeout(requestId, pending)
    pending.onProgress?.(bytesSent, totalBytes)
  }

  resolveRpcError(requestId: string, message: string): void {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingRequests.delete(requestId)
    pending.reject(new Error(message))
  }

  private resetRpcTimeout(requestId: string, pending: PendingRpcRequest): void {
    clearTimeout(pending.timer)
    pending.timer = setTimeout(() => this.timeoutRpcRequest(requestId), pending.timeoutMs)
  }

  private timeoutRpcRequest(requestId: string): void {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) return
    this.pendingRequests.delete(requestId)
    this.sendMessage(pending.bridgeId, {
      type: 'bridge.rpc.cancel',
      id: requestId
    })
    pending.reject(new Error(`Bridge RPC timed out: ${pending.method}`))
  }

  setPrinterStatus(bridgeId: string, status: PrinterStatus): void {
    this.printerStatuses.set(status.printerId, {
      bridgeId,
      status
    })
  }

  removePrinterStatus(printerId: string): void {
    this.printerStatuses.delete(printerId)
  }

  getPrinterStatus(printerId: string): PrinterStatus | null {
    return this.printerStatuses.get(printerId)?.status ?? null
  }

  getBridgeIdForPrinter(printerId: string): string | null {
    return this.printerStatuses.get(printerId)?.bridgeId ?? null
  }

  getConnectionStats(bridgeId: string): {
    connected: boolean
    connectedAt: string | null
    pendingRpcCount: number
    activeCameraWatchCount: number
    activePrinterFtpCount: number
  } {
    const activeConnection = this.connections.get(bridgeId)
    let pendingRpcCount = 0
    for (const pending of this.pendingRequests.values()) {
      if (pending.bridgeId === bridgeId) {
        pendingRpcCount += 1
      }
    }

    let activeCameraWatchCount = 0
    const bridgeListeners = this.cameraListeners.get(bridgeId)
    if (bridgeListeners) {
      for (const listeners of bridgeListeners.values()) {
        activeCameraWatchCount += listeners.size
      }
    }

    let activePrinterFtpCount = 0
    for (const entry of this.printerFtpActivity.values()) {
      if (entry.bridgeId === bridgeId) {
        activePrinterFtpCount += 1
      }
    }

    return {
      connected: activeConnection != null,
      connectedAt: activeConnection?.connectedAt.toISOString() ?? null,
      pendingRpcCount,
      activeCameraWatchCount,
      activePrinterFtpCount
    }
  }

  setPrinterFtpActivity(bridgeId: string, printerId: string, active: boolean): boolean {
    const existing = this.printerFtpActivity.get(printerId)
    if (!active) {
      if (!existing) return false
      this.printerFtpActivity.delete(printerId)
      return true
    }

    if (existing?.bridgeId === bridgeId) return false
    this.printerFtpActivity.set(printerId, { bridgeId })
    return true
  }

  isPrinterFtpActivityActive(printerId: string): boolean {
    return this.printerFtpActivity.has(printerId)
  }

  listActivePrinterFtpActivity(): string[] {
    return [...this.printerFtpActivity.keys()]
  }

  clearBridgePrinterFtpActivity(bridgeId: string): string[] {
    const cleared: string[] = []
    for (const [printerId, entry] of this.printerFtpActivity.entries()) {
      if (entry.bridgeId !== bridgeId) continue
      this.printerFtpActivity.delete(printerId)
      cleared.push(printerId)
    }
    return cleared
  }

  private unsubscribeCameraFrames(bridgeId: string, printerId: string, listener: CameraFrameListener): void {
    const bridgeListeners = this.cameraListeners.get(bridgeId)
    const printerListeners = bridgeListeners?.get(printerId)
    if (!bridgeListeners || !printerListeners) return

    printerListeners.delete(listener)
    if (printerListeners.size > 0) return

    bridgeListeners.delete(printerId)
    if (bridgeListeners.size === 0) {
      this.cameraListeners.delete(bridgeId)
    }

    if (this.connections.has(bridgeId)) {
      this.sendMessage(bridgeId, {
        type: 'bridge.camera.unwatch',
        printerId
      })
    }
  }

  private failCameraListeners(bridgeId: string, error: Error): void {
    const bridgeListeners = this.cameraListeners.get(bridgeId)
    if (!bridgeListeners) return

    this.cameraListeners.delete(bridgeId)
    for (const listeners of bridgeListeners.values()) {
      for (const listener of listeners) {
        listener.onClose(error)
      }
    }
  }
}

export const bridgeSessionManager = new BridgeSessionManager()