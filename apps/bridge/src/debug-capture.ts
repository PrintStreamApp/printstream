/**
 * In-memory ring-buffer capture of the bridge↔printer transport, for debugging
 * connectivity issues without shell access to the bridge host.
 *
 * An operator starts a capture from the web app; while it runs, the bridge taps
 * every MQTT send/receive, FTPS activity toggle, camera lifecycle event,
 * connection transition, and its own console log into a bounded buffer (mirrors
 * `bridge-logs.ts`). The buffer is time-, frame-, and byte-bounded so a forgotten
 * capture can't exhaust memory; it auto-stops at the duration cap. On stop the
 * frames stay buffered until the next capture starts, so they remain downloadable
 * via the `debug.capture.read` RPC.
 *
 * Redaction: tap call sites pass only printer id/name/serial-derived topics and
 * already-parsed MQTT/event payloads — never the LAN access code or a full
 * `Printer` config object. Keep it that way (the access code is a secret).
 *
 * Single capture at a time: the bridge process is single-tenant and a capture is
 * a deliberate, short-lived diagnostic, so a new start discards any prior buffer.
 */
import type {
  BridgeDebugCaptureFrame,
  BridgeDebugCaptureReadResult,
  BridgeDebugCaptureStartParams,
  BridgeDebugCaptureStatus
} from '@printstream/shared'
import { inactiveBridgeDebugCaptureStatus } from '@printstream/shared'
import { subscribeBridgeLogs } from './bridge-logs.js'

const DEFAULT_MAX_FRAMES = 20_000
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_DURATION_MS = 30 * 60 * 1000
const HARD_MAX_FRAMES = 100_000
const HARD_MAX_BYTES = 50 * 1024 * 1024
const HARD_MAX_DURATION_MS = 60 * 60 * 1000
/** Push a live status update to the listener every N frames (counter UX). */
const STATUS_EMIT_EVERY = 25

type StopReason = 'manual' | 'size' | 'duration'

interface CaptureState {
  startedAt: string
  stoppedAt: string | null
  frames: BridgeDebugCaptureFrame[]
  seq: number
  bytes: number
  droppedFrames: number
  truncated: boolean
  maxFrames: number
  maxBytes: number
  autoStopTimer: ReturnType<typeof setTimeout> | null
  unsubscribeLogs: () => void
}

let state: CaptureState | null = null

type StatusListener = (status: BridgeDebugCaptureStatus) => void
let statusListener: StatusListener | null = null

/** Register the single listener notified when capture status changes. */
export function onCaptureStatusChange(listener: StatusListener | null): void {
  statusListener = listener
}

function clamp(value: number | undefined, fallback: number, hardMax: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), hardMax)
}

/** Current capture status, safe to call whether or not a capture exists. */
export function getCaptureStatus(): BridgeDebugCaptureStatus {
  if (!state) return inactiveBridgeDebugCaptureStatus
  return {
    active: state.stoppedAt === null,
    startedAt: state.startedAt,
    stoppedAt: state.stoppedAt,
    frameCount: state.frames.length,
    bytes: state.bytes,
    droppedFrames: state.droppedFrames,
    truncated: state.truncated,
    hasCapture: state.frames.length > 0 || state.stoppedAt !== null
  }
}

export function isCaptureActive(): boolean {
  return state !== null && state.stoppedAt === null
}

function emitStatus(): void {
  if (!statusListener) return
  try {
    statusListener(getCaptureStatus())
  } catch {
    // A faulty listener must never break capture.
  }
}

function discardCapture(): void {
  if (!state) return
  if (state.autoStopTimer) clearTimeout(state.autoStopTimer)
  try {
    state.unsubscribeLogs()
  } catch {
    // ignore
  }
  state = null
}

/** Begin a fresh capture, discarding any prior buffer. */
export function startCapture(params: BridgeDebugCaptureStartParams = {}): BridgeDebugCaptureStatus {
  discardCapture()
  const maxDurationMs = clamp(params.maxDurationMs, DEFAULT_MAX_DURATION_MS, HARD_MAX_DURATION_MS)
  state = {
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    frames: [],
    seq: 0,
    bytes: 0,
    droppedFrames: 0,
    truncated: false,
    maxFrames: clamp(params.maxFrames, DEFAULT_MAX_FRAMES, HARD_MAX_FRAMES),
    maxBytes: clamp(params.maxBytes, DEFAULT_MAX_BYTES, HARD_MAX_BYTES),
    autoStopTimer: setTimeout(() => {
      stopCapture('duration')
    }, maxDurationMs),
    // Fold the bridge's own console output into the capture for reconnect/error
    // context. Replaying recorded frames inside the listener is safe: once
    // stopped, recordCaptureFrame is a no-op.
    unsubscribeLogs: subscribeBridgeLogs((entry) => {
      recordCaptureFrame({
        kind: 'log',
        at: entry.timestamp,
        summary: `[${entry.level}] ${entry.message}`
      })
    })
  }
  console.log('[bridge:debug-capture] started')
  emitStatus()
  return getCaptureStatus()
}

/** Stop the active capture; its frames stay buffered for download. */
export function stopCapture(reason: StopReason = 'manual'): BridgeDebugCaptureStatus {
  if (!state || state.stoppedAt !== null) return getCaptureStatus()
  // Set stoppedAt before any console.log so the re-entrant log frame is ignored.
  state.stoppedAt = new Date().toISOString()
  if (state.autoStopTimer) {
    clearTimeout(state.autoStopTimer)
    state.autoStopTimer = null
  }
  try {
    state.unsubscribeLogs()
  } catch {
    // ignore
  }
  console.log(`[bridge:debug-capture] stopped (${reason}); ${state.frames.length} frames, ${state.bytes} bytes`)
  emitStatus()
  return getCaptureStatus()
}

/** The buffered frames plus window metadata, for the download RPC. */
export function readCapture(): BridgeDebugCaptureReadResult {
  if (!state) {
    return { startedAt: null, stoppedAt: null, frames: [], droppedFrames: 0, truncated: false }
  }
  return {
    startedAt: state.startedAt,
    stoppedAt: state.stoppedAt,
    frames: [...state.frames],
    droppedFrames: state.droppedFrames,
    truncated: state.truncated
  }
}

/**
 * Record one transport frame. No-op unless a capture is active. Enforces the
 * frame ring (drop oldest) and the byte ceiling (mark truncated and auto-stop).
 */
export function recordCaptureFrame(
  frame: Omit<BridgeDebugCaptureFrame, 'seq' | 'at'> & { at?: string }
): void {
  if (!state || state.stoppedAt !== null) return
  const full: BridgeDebugCaptureFrame = {
    seq: state.seq,
    at: frame.at ?? new Date().toISOString(),
    kind: frame.kind,
    direction: frame.direction,
    printerId: frame.printerId,
    printerName: frame.printerName,
    topic: frame.topic,
    summary: frame.summary,
    payload: frame.payload
  }

  let size = 0
  try {
    size = Buffer.byteLength(JSON.stringify(full))
  } catch {
    // A non-serializable payload still gets recorded (with a placeholder) rather
    // than silently dropped, so the capture stays a faithful record.
    full.payload = '[unserializable]'
    size = Buffer.byteLength(JSON.stringify(full))
  }

  if (state.bytes + size > state.maxBytes) {
    state.truncated = true
    stopCapture('size')
    return
  }

  state.seq += 1
  state.frames.push(full)
  state.bytes += size
  if (state.frames.length > state.maxFrames) {
    state.frames.shift()
    state.droppedFrames += 1
  }
  if (state.seq % STATUS_EMIT_EVERY === 0) emitStatus()
}
