/** Owns the editor catalogue snapshot and its explicit, user-requested refresh boundary. */
import { useCallback, useRef, useState } from 'react'
import { useHeldSnapshot } from './useHeldSnapshot'

/** Background query updates stay held; refresh releases the snapshot for a user edit. */
export function useSlicingPresetsSnapshot<T>(value: T, options: {
  hold: boolean
  ready: boolean
  scope: string
  refetch: (options?: { cancelRefetch?: boolean }) => Promise<{ isSuccess: boolean; isFetching?: boolean }>
}) {
  const [token, setToken] = useState(0)
  const { refetch } = options
  const scopeRef = useRef(options.scope)
  scopeRef.current = options.scope
  const refresh = useCallback(async () => {
    // Keep the old snapshot while loading. Releasing it before the request finishes would
    // immediately freeze the stale cached catalogue again. Failed reads preserve the session.
    const scope = options.scope
    let result = await refetch({ cancelRefetch: false })
    // A socket invalidation can cancel the fetch we joined and replace it. TanStack then
    // returns the old successful cache with isFetching still true. Join the replacement
    // rather than freezing those old values or dropping this user's refresh request.
    while (result.isFetching && scope === scopeRef.current) {
      result = await refetch({ cancelRefetch: false })
    }
    if (result.isSuccess && scope === scopeRef.current) {
      setToken((current) => current + 1)
    }
  }, [refetch, options.scope])

  const profiles = useHeldSnapshot(value, { ...options, token })
  return { profiles, refresh, revision: token }
}
