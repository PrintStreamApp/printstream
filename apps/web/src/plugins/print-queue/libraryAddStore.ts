/**
 * Tiny module store bridging the library file menu ("Add to queue") to the queue's
 * add flow. The menu item unmounts when the menu closes, so it can't host a dialog;
 * instead it records the requested file here, and the always-mounted `library.overlays`
 * host renders the right flow. No core changes, no cross-plugin imports.
 *
 * `kind: 'direct'` is a directly-printable file (opens the add dialog); `kind: 'slice'`
 * is an unsliced project 3MF (slice first, then add the sliced output to the queue).
 */
import { useSyncExternalStore } from 'react'

export interface QueueAddRequest {
  kind: 'direct' | 'slice'
  id: string
  name: string
}

let current: QueueAddRequest | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function requestAddToQueue(file: { id: string; name: string }): void {
  current = { kind: 'direct', id: file.id, name: file.name }
  emit()
}

export function requestSliceThenQueue(file: { id: string; name: string }): void {
  current = { kind: 'slice', id: file.id, name: file.name }
  emit()
}

export function clearAddToQueueRequest(): void {
  current = null
  emit()
}

export function useAddToQueueRequest(): QueueAddRequest | null {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    () => current,
    () => current
  )
}
