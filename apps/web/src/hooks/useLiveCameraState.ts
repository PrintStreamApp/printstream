import { useCallback, useSyncExternalStore } from 'react'

const activeStreams = new Map<string, number>()
const listeners = new Set<() => void>()

function emitChange(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function markLiveCameraStreamActive(printerId: string): void {
  const current = activeStreams.get(printerId) ?? 0
  activeStreams.set(printerId, current + 1)
  if (current === 0) {
    emitChange()
  }
}

export function markLiveCameraStreamInactive(printerId: string): void {
  const current = activeStreams.get(printerId) ?? 0
  if (current <= 1) {
    if (current > 0) {
      activeStreams.delete(printerId)
      emitChange()
    }
    return
  }

  activeStreams.set(printerId, current - 1)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function isLiveCameraStreamActive(printerId: string): boolean {
  return (activeStreams.get(printerId) ?? 0) > 0
}

export function useLiveCameraStreamActive(printerId: string): boolean {
  const getSnapshot = useCallback(() => isLiveCameraStreamActive(printerId), [printerId])
  const getServerSnapshot = useCallback(() => false, [])
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}