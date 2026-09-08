import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Small localStorage-backed state helper for UI preferences. Storage is
 * best-effort so private browsing or quota errors fall back gracefully.
 *
 * **Every instance reading a key sees another instance's write.** These are PREFERENCES: two
 * mounted copies of one setting disagreeing is always a bug, not a feature. Without this, a
 * settings dialog that wrote a preference updated only its own control while the surface the
 * preference governs kept its stale value until it remounted: the setting looked broken, and it
 * only showed up where localStorage is the ONLY tier (the public editor's viewport preferences;
 * inside a workspace the same controls also write a server-side default whose React Query cache
 * update re-rendered everyone, hiding this).
 *
 * Same-tab only, deliberately: the `storage` event would also sync other TABS, which is a broader
 * behaviour change than the bug requires. Revisit if a preference ever needs to follow across tabs.
 *
 * **Renaming a key needs `legacyKeys`.** A storage key is a persisted identifier: renaming one
 * without a read-through silently resets everybody's saved preference on the first load after a
 * deploy, which nobody reports as a bug because it looks like they never set it. Pass the old
 * name(s) and the first load migrates the value forward.
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
  serialize: (value: T) => string = JSON.stringify,
  /**
   * Former names for this key, newest first. Read only when `key` itself holds
   * nothing; the next write lands on `key`, so the migration happens once and
   * the old entry is simply left behind rather than deleted (another tab on the
   * previous build may still be reading it).
   */
  legacyKeys: ReadonlyArray<string> = []
): [T, (value: T) => void, boolean] {
  // Stable across renders so callers can pass an inline array literal without
  // re-running the read on every render.
  const legacyKeysRef = useRef(legacyKeys)
  legacyKeysRef.current = legacyKeys
  const readValue = useCallback(() => {
    if (typeof window === 'undefined') return fallback
    try {
      const raw = window.localStorage.getItem(key)
        ?? legacyKeysRef.current.map((legacy) => window.localStorage.getItem(legacy)).find((value) => value != null)
        ?? null
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
  // Read through refs so the subscription below depends only on `key`: callers routinely pass
  // inline `parse` functions, which would otherwise resubscribe on every render.
  const parseRef = useRef(parse)
  parseRef.current = parse
  const serializeRef = useRef(serialize)
  serializeRef.current = serialize
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
      // Guarded exactly as the initial read is, and for the same reason: a stored value can be
      // malformed and a `parse` built on `JSON.parse` throws on it. Unguarded, that throw happens
      // synchronously inside `notifyKey`, which runs inside the WRITING instance's effect, so one
      // component's bad value took down an unrelated component's render instead of falling back.
      let next: T
      let synced: string | null = serialized
      try {
        next = parseRef.current(serialized) ?? fallbackRef.current
      } catch {
        next = fallbackRef.current
        // `syncedRef` records what this instance has SYNCED, and on a parse failure that is the
        // fallback, not the value it could not read. Recording `serialized` here made the write
        // effect see a disagreement between its state and its synced form, so it wrote the fallback
        // straight back to storage and notified: one instance's unreadable value silently REPLACED
        // the writer's, and the writer's own displayed state flipped to the reader's fallback.
        try {
          synced = serializeRef.current(next)
        } catch {
          synced = syncedRef.current
        }
      }
      syncedRef.current = synced
      setValue(next)
    })
  }, [key])

  return [value, setValue, loadedKey === key]
}
