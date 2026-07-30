import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Small localStorage-backed state helper for UI preferences. Storage is
 * best-effort so private browsing or quota errors fall back gracefully.
 *
 * **Every instance reading a key sees another instance's write.** These are PREFERENCES: two
 * mounted copies of one setting disagreeing is always a bug, not a feature. Without this, a
 * settings dialog that wrote a preference updated only its own control while the surface the
 * preference governs kept its stale value until it remounted — the setting looked broken, and it
 * only showed up where localStorage is the ONLY tier (the public editor's viewport preferences;
 * inside a workspace the same controls also write a server-side default whose React Query cache
 * update re-rendered everyone, hiding this).
 *
 * Same-tab only, deliberately: the `storage` event would also sync other TABS, which is a broader
 * behaviour change than the bug requires. Revisit if a preference ever needs to follow across tabs.
 */

/** Listeners per storage key, so a write can reach the other instances reading it. */
const keySubscribers = new Map<string, Set<(serialized: string) => void>>()

function subscribeToKey(key: string, listener: (serialized: string) => void): () => void {
  let listeners = keySubscribers.get(key)
  if (!listeners) {
    listeners = new Set()
    keySubscribers.set(key, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) keySubscribers.delete(key)
  }
}

function notifyKey(key: string, serialized: string): void {
  // Copied before iterating: a listener may unsubscribe (unmount) while being notified.
  for (const listener of [...(keySubscribers.get(key) ?? [])]) listener(serialized)
}

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
  /**
   * The serialized form this instance last synced for `loadedKey`. Compared before both writing and
   * accepting a notification, which is what stops two instances bouncing a value between them: a
   * `parse` that returns a fresh object per call (the JSON case) is never `Object.is`-equal, so
   * without this guard each notification would produce a new state object and notify back forever.
   */
  const syncedRef = useRef<string | null>(null)
  // Read through refs so the subscription below depends only on `key` — callers routinely pass
  // inline `parse` functions, which would otherwise resubscribe on every render.
  const parseRef = useRef(parse)
  parseRef.current = parse
  const fallbackRef = useRef(fallback)
  fallbackRef.current = fallback

  useEffect(() => {
    if (loadedKey === key) return
    setValue(readValue())
    setLoadedKey(key)
    // A different key has its own synced value; keep nothing from the previous one.
    syncedRef.current = null
  }, [key, loadedKey, readValue])

  useEffect(() => {
    if (loadedKey !== key) return
    if (typeof window === 'undefined') return
    const serialized = serialize(value)
    if (serialized === syncedRef.current) return
    syncedRef.current = serialized
    try {
      window.localStorage.setItem(key, serialized)
    } catch {
      /* ignore unavailable storage */
    }
    // After the write, so a listener that re-reads storage sees the new value.
    notifyKey(key, serialized)
  }, [key, loadedKey, serialize, value])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    return subscribeToKey(key, (serialized) => {
      // Skips the writer's own notification, and any that matches what this instance already holds.
      if (serialized === syncedRef.current) return
      syncedRef.current = serialized
      setValue(parseRef.current(serialized) ?? fallbackRef.current)
    })
  }, [key])

  return [value, setValue, loadedKey === key]
}
