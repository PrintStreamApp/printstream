/**
 * Shared chamber-camera snapshot cache.
 *
 * Printer-card thumbnails are requested independently by every open web
 * client. This module coalesces those requests so each printer performs
 * at most one TLS camera snapshot fetch per short freshness window, and
 * concurrent requests share the same in-flight printer read.
 */
import type { Printer } from '@printstream/shared'
import { fetchSnapshot } from './camera.js'
import { cameraStreamHub } from './camera-stream-hub.js'

const SNAPSHOT_TTL_MS = 5_000
const STALE_ENTRY_MS = 60_000
const LIVE_STREAM_FRAME_MAX_AGE_MS = 2_500

interface SnapshotEntry {
  frame: Buffer | null
  capturedAt: number
  inflight: Promise<Buffer> | null
}

const snapshots = new Map<string, SnapshotEntry>()

export async function getSharedCameraSnapshot(printer: Printer): Promise<Buffer> {
  const key = snapshotKey(printer)
  const now = Date.now()
  pruneSnapshots(now)

  const liveFrame = cameraStreamHub.getLatestFrame(printer.id, {
    maxAgeMs: LIVE_STREAM_FRAME_MAX_AGE_MS,
    requireListeners: true
  })
  if (liveFrame) {
    const entry = snapshots.get(key) ?? { frame: null, capturedAt: 0, inflight: null }
    entry.frame = liveFrame
    entry.capturedAt = now
    snapshots.set(key, entry)
    return liveFrame
  }

  const existing = snapshots.get(key)
  if (existing?.frame && now - existing.capturedAt <= SNAPSHOT_TTL_MS) {
    return existing.frame
  }
  if (existing?.inflight) {
    return existing.inflight
  }

  const entry = existing ?? { frame: null, capturedAt: 0, inflight: null }
  const inflight = fetchSnapshot(printer)
    .then((frame) => {
      entry.frame = frame
      entry.capturedAt = Date.now()
      return frame
    })
    .finally(() => {
      entry.inflight = null
    })
  entry.inflight = inflight
  snapshots.set(key, entry)
  return inflight
}

export async function refreshSharedCameraSnapshot(printer: Printer): Promise<Buffer> {
  const key = snapshotKey(printer)
  const now = Date.now()
  pruneSnapshots(now)

  const liveFrame = cameraStreamHub.getLatestFrame(printer.id, {
    maxAgeMs: LIVE_STREAM_FRAME_MAX_AGE_MS,
    requireListeners: true
  })
  if (liveFrame) {
    const entry = snapshots.get(key) ?? { frame: null, capturedAt: 0, inflight: null }
    entry.frame = liveFrame
    entry.capturedAt = now
    entry.inflight = null
    snapshots.set(key, entry)
    return liveFrame
  }

  const existing = snapshots.get(key)
  if (existing?.inflight) {
    return existing.inflight
  }

  const entry = existing ?? { frame: null, capturedAt: 0, inflight: null }
  const inflight = fetchSnapshot(printer)
    .then((frame) => {
      entry.frame = frame
      entry.capturedAt = Date.now()
      return frame
    })
    .finally(() => {
      entry.inflight = null
    })

  entry.inflight = inflight
  snapshots.set(key, entry)
  return inflight
}

function snapshotKey(printer: Printer): string {
  return `${printer.id}:${printer.host}:${printer.serial}`
}

function pruneSnapshots(now: number): void {
  for (const [key, entry] of snapshots.entries()) {
    if (!entry.inflight && now - entry.capturedAt > STALE_ENTRY_MS) {
      snapshots.delete(key)
    }
  }
}