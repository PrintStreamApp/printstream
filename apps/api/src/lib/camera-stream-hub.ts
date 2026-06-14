/**
 * Shared chamber-camera stream hub.
 *
 * Maintains at most one active printer camera stream per printer inside
 * the API process. WebSocket viewers and legacy MJPEG clients subscribe
 * to this hub, so opening the same camera in multiple components or
 * browser sessions fans out one upstream printer read instead of creating
 * duplicate TLS/RTSP connections.
 */
import { streamFrames, supportsChamberCamera } from './camera.js'
import { paceCameraFrames, type CameraFramePacer } from './camera-frame-pacer.js'
import { printerManager } from './printer-manager.js'

export type CameraFrameListener = (frame: Buffer) => void

interface CameraStream {
  listeners: Set<CameraFrameListener>
  controller: AbortController
  /** Most recent frame, delivered immediately to new subscribers. */
  lastFrame: Buffer | null
  /** Timestamp for the most recent upstream frame. */
  lastFrameAt: number
  /** Pending shutdown after the last listener leaves. */
  graceTimer: NodeJS.Timeout | null
  /** Timestamp when the stream became idle and entered the grace period. */
  idleSince: number | null
  /** Number of upstream stream attempts started for this printer. */
  streamAttempt: number
  /** Number of reconnects scheduled while listeners were still present. */
  reconnectCount: number
}

/**
 * Keep the camera socket alive briefly after the last viewer leaves so
 * quick dialog reopens reuse the same stream and the cached latest frame.
 */
const GRACE_PERIOD_MS = 30_000
const STREAM_RETRY_DELAY_MS = 1_000

interface CameraStreamHubOptions {
  gracePeriodMs?: number
  streamRetryDelayMs?: number
  getNow?: () => number
  getPrinter?: (printerId: string) => ReturnType<typeof printerManager.getPrinter>
  readFrames?: typeof streamFrames
  /**
   * Smooths the upstream frame cadence before fan-out. Defaults to an adaptive
   * playout buffer; tests can inject a pass-through to keep timing deterministic.
   */
  framePacer?: CameraFramePacer
}

interface LatestFrameOptions {
  maxAgeMs?: number
  requireListeners?: boolean
}

export class CameraStreamHub {
  private readonly streams = new Map<string, CameraStream>()

  private readonly gracePeriodMs: number

  private readonly streamRetryDelayMs: number

  private readonly getNow: () => number

  private readonly getPrinter: (printerId: string) => ReturnType<typeof printerManager.getPrinter>

  private readonly readFrames: typeof streamFrames

  private readonly framePacer: CameraFramePacer

  constructor(options: CameraStreamHubOptions = {}) {
    this.gracePeriodMs = options.gracePeriodMs ?? GRACE_PERIOD_MS
    this.streamRetryDelayMs = options.streamRetryDelayMs ?? STREAM_RETRY_DELAY_MS
    this.getNow = options.getNow ?? (() => Date.now())
    this.getPrinter = options.getPrinter ?? ((printerId) => printerManager.getPrinter(printerId))
    this.readFrames = options.readFrames ?? streamFrames
    this.framePacer = options.framePacer ?? paceCameraFrames
  }

  subscribe(printerId: string, listener: CameraFrameListener): () => void {
    const stream = this.getOrCreateStream(printerId)
    stream.listeners.add(listener)

    if (stream.graceTimer) {
      const idleForMs = stream.idleSince == null ? null : Math.max(0, this.getNow() - stream.idleSince)
      clearTimeout(stream.graceTimer)
      stream.graceTimer = null
      stream.idleSince = null
      console.debug(
        `[camera-stream-hub:${printerId}] reused upstream stream during grace period${idleForMs == null ? '' : ` after ${idleForMs}ms idle`} (listeners=${stream.listeners.size})`
      )
    }

    if (stream.lastFrame) {
      queueMicrotask(() => {
        if (stream.listeners.has(listener)) listener(stream.lastFrame as Buffer)
      })
    }

    return () => this.unsubscribe(printerId, listener)
  }

  getLatestFrame(printerId: string, options: LatestFrameOptions = {}): Buffer | null {
    const stream = this.streams.get(printerId)
    if (!stream || !stream.lastFrame) return null
    if (options.requireListeners && stream.listeners.size === 0) return null
    if (options.maxAgeMs != null && this.getNow() - stream.lastFrameAt > options.maxAgeMs) return null
    return Buffer.from(stream.lastFrame)
  }

  private getOrCreateStream(printerId: string): CameraStream {
    const existing = this.streams.get(printerId)
    if (existing) return existing

    const stream: CameraStream = {
      listeners: new Set(),
      controller: new AbortController(),
      lastFrame: null,
      lastFrameAt: 0,
      graceTimer: null,
      idleSince: null,
      streamAttempt: 0,
      reconnectCount: 0
    }
    this.streams.set(printerId, stream)
    void this.pump(printerId, stream)
    return stream
  }

  private unsubscribe(printerId: string, listener: CameraFrameListener): void {
    const stream = this.streams.get(printerId)
    if (!stream) return

    stream.listeners.delete(listener)
    if (stream.listeners.size > 0 || stream.graceTimer) return

    stream.idleSince = this.getNow()
    stream.graceTimer = setTimeout(() => {
      console.debug(
        `[camera-stream-hub:${printerId}] closing idle upstream stream after ${this.gracePeriodMs}ms grace period`
      )
      stream.controller.abort()
      this.streams.delete(printerId)
    }, this.gracePeriodMs)
  }

  private async pump(printerId: string, stream: CameraStream): Promise<void> {
    const printer = this.getPrinter(printerId)
    if (!printer || !supportsChamberCamera(printer.model)) {
      this.streams.delete(printerId)
      return
    }

    stream.streamAttempt += 1
    const attempt = stream.streamAttempt
    console.debug(
      `[camera-stream-hub:${printerId}] starting upstream stream attempt=${attempt} model=${printer.model}`
    )

    try {
      const pacedFrames = this.framePacer(
        this.readFrames(printer, stream.controller.signal),
        { signal: stream.controller.signal }
      )
      for await (const frame of pacedFrames) {
        stream.lastFrame = frame
        stream.lastFrameAt = this.getNow()
        if (stream.listeners.size === 0) continue
        for (const listener of stream.listeners) {
          listener(frame)
        }
      }
    } catch (error) {
      if (!stream.controller.signal.aborted) {
        console.warn(
          `[camera-stream-hub:${printerId}] upstream stream attempt=${attempt} failed: ${(error as Error).message}`
        )
      }
    }

    if (stream.graceTimer) {
      clearTimeout(stream.graceTimer)
      stream.graceTimer = null
    }

    if (!stream.controller.signal.aborted && stream.listeners.size > 0 && this.streams.get(printerId) === stream) {
      stream.reconnectCount += 1
      console.warn(
        `[camera-stream-hub:${printerId}] scheduling reconnect #${stream.reconnectCount} in ${this.streamRetryDelayMs}ms (listeners=${stream.listeners.size})`
      )
      setTimeout(() => {
        if (!stream.controller.signal.aborted && stream.listeners.size > 0 && this.streams.get(printerId) === stream) {
          void this.pump(printerId, stream)
        }
      }, this.streamRetryDelayMs)
      return
    }

    this.streams.delete(printerId)
  }
}

export const cameraStreamHub = new CameraStreamHub()