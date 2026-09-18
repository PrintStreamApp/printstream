import { useRef } from 'react'

/**
 * Holds the first ready value until an explicit refresh or a change of data scope.
 *
 * This is the editor's snapshot-at-open rule made concrete for the slicer catalogue. The editor
 * borrows this controller, and the catalogue can refetch underneath it for reasons the user never
 * asked for: staleness, window focus, or a `slicing.profiles` WS invalidation raised by somebody
 * else's edit. A catalogue that changes shape mid-session re-runs the process re-pick, which is how
 * a project's own preset silently became a built-in.
 *
 * Only holds once READY, never before: freezing a half-loaded catalogue is the very failure this is
 * meant to prevent (see `projectPresetsReady` in useProcessProfileSelection). `hold: false` opts a
 * host out entirely, which is what the slim print dialog wants, it has no editor to protect and
 * should track the catalogue live.
 */
export function useHeldSnapshot<T>(value: T, { hold, ready, token, scope }: { hold: boolean; ready: boolean; token: number; scope?: string }): T {
  const heldRef = useRef<T | null>(null)
  const tokenRef = useRef(token)
  const scopeRef = useRef(scope)
  if (!hold) {
    heldRef.current = null
    return value
  }
  // A refresh or engine change drops the snapshot so the next
  // ready value is adopted. Compared during render so the fresh value is served on the same frame.
  if (token !== tokenRef.current || scope !== scopeRef.current) {
    scopeRef.current = scope
    tokenRef.current = token
    heldRef.current = null
  }
  if (heldRef.current === null && ready) heldRef.current = value
  return heldRef.current ?? value
}
