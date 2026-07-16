/**
 * Reference-counted "someone is watching this printer's camera snapshot" signal.
 *
 * Many cards can want the same printer's snapshots at once, so watches are
 * counted per printer: the first watcher sends `camera.snapshot.watch` over the
 * WS and the last release sends `camera.snapshot.unwatch`, so the server streams
 * a printer's snapshots only while at least one component is interested. The hook
 * returns a version number (the latest capture timestamp) that bumps on each new
 * snapshot so `useSyncExternalStore` re-renders consumers.
 *
 * The watch registry is module-level (shared across all mounts), and on every WS
 * reconnect (`onOpen`) the still-active watches are re-sent — the server forgets
 * subscriptions when the socket drops, so without this replay a reconnected page
 * would silently stop receiving snapshots.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { wsClient } from '../lib/wsClient'

const snapshotVersions = new Map<string, number>()
const listeners = new Map<string, Set<() => void>>()
const watchCounts = new Map<string, number>()

let replayRegistered = false

function emit(printerId: string): void {
  for (const listener of listeners.get(printerId) ?? []) {
    listener()
  }
}

function ensureReplayRegistered(): void {
  if (replayRegistered) return
  replayRegistered = true
  wsClient.onOpen(() => {
    for (const [printerId, count] of watchCounts) {
      if (count > 0) {
        wsClient.send(JSON.stringify({ type: 'camera.snapshot.watch', printerId }))
      }
    }
  })
}

function retainWatch(printerId: string): void {
  ensureReplayRegistered()
  const nextCount = (watchCounts.get(printerId) ?? 0) + 1
  watchCounts.set(printerId, nextCount)
  if (nextCount === 1) {
    wsClient.send(JSON.stringify({ type: 'camera.snapshot.watch', printerId }))
  }
}

function releaseWatch(printerId: string): void {
  const current = watchCounts.get(printerId) ?? 0
  if (current <= 1) {
    watchCounts.delete(printerId)
    wsClient.send(JSON.stringify({ type: 'camera.snapshot.unwatch', printerId }))
    return
  }

  watchCounts.set(printerId, current - 1)
}

export function markSnapshotUpdated(printerId: string, capturedAt: number): void {
  const current = snapshotVersions.get(printerId)
  if (current === capturedAt) return
  snapshotVersions.set(printerId, capturedAt)
  emit(printerId)
}

function subscribe(printerId: string, listener: () => void): () => void {
  let printerListeners = listeners.get(printerId)
  if (!printerListeners) {
    printerListeners = new Set<() => void>()
    listeners.set(printerId, printerListeners)
  }

  printerListeners.add(listener)
  return () => {
    const current = listeners.get(printerId)
    current?.delete(listener)
    if (current && current.size === 0) {
      listeners.delete(printerId)
    }
  }
}

export function useSnapshotInterest(printerId: string, enabled: boolean): number {
  const version = useSyncExternalStore(
    (listener) => subscribe(printerId, listener),
    () => snapshotVersions.get(printerId) ?? 0,
    () => 0
  )

  useEffect(() => {
    if (!enabled) return

    retainWatch(printerId)
    return () => {
      releaseWatch(printerId)
    }
  }, [enabled, printerId])

  return version
}