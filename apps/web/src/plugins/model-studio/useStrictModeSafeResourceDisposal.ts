/**
 * Dispose an owned resource after a real unmount or replacement, without treating React
 * StrictMode's development-only setup/cleanup/setup probe as a real close.
 */
import { useEffect, useRef } from 'react'

export function useStrictModeSafeResourceDisposal<T extends object>(
  resource: T,
  owned: boolean,
  dispose: (resource: T) => void
): void {
  const disposeRef = useRef(dispose)
  disposeRef.current = dispose
  const pendingRef = useRef(new Map<T, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    if (!owned) return
    const pendingDisposals = pendingRef.current

    // StrictMode re-runs this setup synchronously with the same resource. A genuine replacement
    // has a different identity, so its previous timer remains armed and releases only the old one.
    const pending = pendingDisposals.get(resource)
    if (pending !== undefined) {
      clearTimeout(pending)
      pendingDisposals.delete(resource)
    }

    return () => {
      const timer = setTimeout(() => {
        pendingDisposals.delete(resource)
        disposeRef.current(resource)
      }, 0)
      pendingDisposals.set(resource, timer)
    }
  }, [owned, resource])
}
