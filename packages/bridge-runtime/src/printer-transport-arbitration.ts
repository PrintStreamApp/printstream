/**
 * Coordinates bridge-local printer transports that should not overlap.
 *
 * FTPS operations and TLS chamber-camera access compete for limited printer-side
 * resources. This module tracks active FTPS work per printer so callers that
 * share that transport can wait or pause until storage traffic settles.
 */

const activeFtpCounts = new Map<string, number>()
const activityListeners = new Map<string, Set<(active: boolean) => void>>()

export function beginFtpActivity(printerId: string): () => void {
  const nextCount = (activeFtpCounts.get(printerId) ?? 0) + 1
  activeFtpCounts.set(printerId, nextCount)
  if (nextCount === 1) {
    emitActivityChange(printerId, true)
  }

  let ended = false
  return () => {
    if (ended) return
    ended = true

    const currentCount = activeFtpCounts.get(printerId) ?? 0
    if (currentCount <= 1) {
      if (currentCount > 0) {
        activeFtpCounts.delete(printerId)
        emitActivityChange(printerId, false)
      }
      return
    }

    activeFtpCounts.set(printerId, currentCount - 1)
  }
}

export function isFtpActivityActive(printerId: string): boolean {
  return (activeFtpCounts.get(printerId) ?? 0) > 0
}

export function onFtpActivityChange(printerId: string, listener: (active: boolean) => void): () => void {
  let listeners = activityListeners.get(printerId)
  if (!listeners) {
    listeners = new Set()
    activityListeners.set(printerId, listeners)
  }
  listeners.add(listener)

  return () => {
    const current = activityListeners.get(printerId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) {
      activityListeners.delete(printerId)
    }
  }
}

export function waitForFtpIdle(printerId: string, signal?: AbortSignal): Promise<void> {
  if (!isFtpActivityActive(printerId)) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(createAbortError())

  return new Promise<void>((resolve, reject) => {
    const unsubscribe = onFtpActivityChange(printerId, (active) => {
      if (active) return
      cleanup()
      resolve()
    })

    const onAbort = () => {
      cleanup()
      reject(createAbortError())
    }

    const cleanup = () => {
      unsubscribe()
      signal?.removeEventListener('abort', onAbort)
    }

    if (!isFtpActivityActive(printerId)) {
      cleanup()
      resolve()
      return
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function resetPrinterTransportArbitrationForTests(): void {
  activeFtpCounts.clear()
  activityListeners.clear()
}

function emitActivityChange(printerId: string, active: boolean): void {
  const listeners = activityListeners.get(printerId)
  if (!listeners) return
  for (const listener of listeners) {
    listener(active)
  }
}

function createAbortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}