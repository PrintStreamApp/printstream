import { useCallback, useSyncExternalStore } from 'react'

const activePrinters = new Set<string>()
const listeners = new Set<() => void>()

function emitChange(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function markPrinterFtpActivity(printerId: string, active: boolean): void {
  const hadPrinter = activePrinters.has(printerId)
  if (active) {
    if (hadPrinter) return
    activePrinters.add(printerId)
    emitChange()
    return
  }

  if (!hadPrinter) return
  activePrinters.delete(printerId)
  emitChange()
}

export function clearPrinterFtpActivity(): void {
  if (activePrinters.size === 0) return
  activePrinters.clear()
  emitChange()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function isPrinterFtpActive(printerId: string): boolean {
  return activePrinters.has(printerId)
}

export function usePrinterFtpActivityActive(printerId: string): boolean {
  const getSnapshot = useCallback(() => isPrinterFtpActive(printerId), [printerId])
  const getServerSnapshot = useCallback(() => false, [])
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
