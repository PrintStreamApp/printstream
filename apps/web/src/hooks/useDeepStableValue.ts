import { useRef } from 'react'
import { deepEqual } from '@printstream/shared'

/**
 * Returns a referentially stable version of `value`: the previous reference is
 * preserved as long as the new value is deeply equal to it. This insulates
 * memoized derivations and child components from inputs that are rebuilt on
 * every render (for example printer status objects that are re-parsed from each
 * WebSocket frame) but whose relevant contents have not actually changed.
 */
export function useDeepStableValue<T>(value: T): T {
  const ref = useRef(value)
  if (!deepEqual(ref.current, value)) {
    ref.current = value
  }
  return ref.current
}
