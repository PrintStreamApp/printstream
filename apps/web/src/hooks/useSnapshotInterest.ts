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