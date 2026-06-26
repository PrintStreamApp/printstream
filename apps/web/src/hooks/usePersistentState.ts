import { useCallback } from 'react'
import { useLocalStorageState } from './useLocalStorageState'

/**
 * localStorage-backed state for a JSON-serializable UI preference (a directory
 * view's sort / grouping / filters / page size / view mode, etc.). Thin wrapper
 * over {@link useLocalStorageState} that handles JSON (de)serialization and
 * routes every read through `sanitize`, so a stale, partial, or hand-edited
 * entry can never crash the view — it degrades to a valid value instead.
 *
 * `sanitize` receives the parsed JSON (`unknown`) and must return a fully valid
 * value of `T` (typically by merging the stored fields over the defaults and
 * dropping anything unrecognized). Keep it stable — define it at module scope or
 * wrap it in `useCallback` — because it keys the storage read.
 *
 * The returned setter is React's `useState` dispatch, so functional updates
 * (`setValue(prev => ...)`) work, which is what per-field setters built on top of
 * a combined preferences object rely on.
 */
export function usePersistentState<T>(
  key: string,
  fallback: T,
  sanitize: (value: unknown) => T
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const parse = useCallback((raw: string): T | null => {
    try {
      return sanitize(JSON.parse(raw) as unknown)
    } catch {
      return null
    }
  }, [sanitize])
  const [value, setValue] = useLocalStorageState<T>(key, fallback, parse)
  // useLocalStorageState's setter is the underlying useState dispatch, so it
  // genuinely supports functional updaters even though its type narrows that away.
  return [value, setValue as React.Dispatch<React.SetStateAction<T>>]
}
