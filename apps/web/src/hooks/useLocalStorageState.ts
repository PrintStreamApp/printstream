import { useCallback, useEffect, useState } from 'react'

/**
 * Small localStorage-backed state helper for UI preferences. Storage is
 * best-effort so private browsing or quota errors fall back gracefully.
 */
export function useLocalStorageState<T>(
  key: string,
  fallback: T,
  parse: (raw: string) => T | null,
  serialize: (value: T) => string = JSON.stringify
): [T, (value: T) => void, boolean] {
  const readValue = useCallback(() => {
    if (typeof window === 'undefined') return fallback
    try {
      const raw = window.localStorage.getItem(key)
      if (raw == null) return fallback
      return parse(raw) ?? fallback
    } catch {
      return fallback
    }
  }, [fallback, key, parse])
  const [value, setValue] = useState<T>(readValue)
  const [loadedKey, setLoadedKey] = useState(key)

  useEffect(() => {
    if (loadedKey === key) return
    setValue(readValue())
    setLoadedKey(key)
  }, [key, loadedKey, readValue])

  useEffect(() => {
    if (loadedKey !== key) return
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(key, serialize(value))
    } catch {
      /* ignore unavailable storage */
    }
  }, [key, loadedKey, serialize, value])

  return [value, setValue, loadedKey === key]
}