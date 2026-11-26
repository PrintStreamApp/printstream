/** Bridges short-lived Upload menu items to the persistent library overlay host. */
import { useSyncExternalStore } from 'react'
import type { NativeModelProvider } from '../../native/bridge'

export interface ImportLaunch {
  workspaceSlug?: string
  source: NativeModelProvider | 'url'
  bridgeId: string | null
  folderId: string | null
}

let current: ImportLaunch | null = null
const listeners = new Set<() => void>()

export function openLibraryImport(launch: ImportLaunch): void {
  // A native browsing session can outlive its initial click. Keep its owner stable.
  if (current) return
  current = launch
  for (const listener of listeners) listener()
}

export function closeLibraryImport(): void {
  current = null
  for (const listener of listeners) listener()
}

export function useLibraryImportLaunch(): ImportLaunch | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
    () => null
  )
}
