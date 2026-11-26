/**
 * The registry of browser storage keys (CONF-7, D-105).
 *
 * Every localStorage and sessionStorage key the web app uses is declared with `defineStorageKey`
 * (one fixed key) or `defineStorageKeyFamily` (a key with a per-workspace, per-printer or similar
 * suffix). Declarations live with their owner, one `storageKeys.ts` per owner (core, each plugin,
 * the private cloud module), so core never names a plugin's or a private module's keys; this module
 * only collects them, so they can be listed, checked and reset.
 *
 * Names follow D-105: `printstream.<area>.<name>`, with a `.v<N>` suffix only when the stored shape
 * changes. A renamed key lists its former names in `legacyKeys`; reads fall back to them while the
 * new key is empty, and the next write lands on the new key (the read-old, write-new migration
 * CONF-7 requires). Caches list their former names as `retiredKeys` instead: they refill
 * themselves, so the old entry is only cleared, never read.
 *
 * Domain-neutral on purpose: owners decide what a key holds; this module only knows its storage,
 * its kind and its names.
 */

/** Which browser store a key lives in. */
export type BrowserStorageArea = 'local' | 'session'

/**
 * What a key holds, which decides how a rename is handled.
 * - `preference`: a choice the user made; carried over on rename.
 * - `record`: data the user cannot get back otherwise (a dismissal, a read marker, local profiles);
 *   carried over on rename.
 * - `flow`: short-lived state for one flow (a return path, a one-shot flag); carried over on rename.
 * - `cache`: data that refills itself; old names are cleared, not read.
 * - `library`: a key a third-party library reads and writes itself; nothing here reads it.
 */
export type BrowserStorageKind = 'preference' | 'record' | 'flow' | 'cache' | 'library'

/**
 * Everything a reader or writer needs for one concrete key: its name, its former names and its
 * store. A fixed key's definition is one; a family hands one out per suffix with `at()`. The storage
 * hooks and the helpers below accept it, so a call site never repeats a key's legacy names.
 */
export interface StorageKeyRef {
  key: string
  storage: BrowserStorageArea
  legacyKeys: readonly string[]
  retiredKeys: readonly string[]
}

interface StorageKeyBase {
  storage: BrowserStorageArea
  kind: BrowserStorageKind
  /** Who declares it: `core`, `plugin:<name>` or `private:<module>`. */
  owner: string
}

/** One fixed key. `legacyKeys` are read while `key` is empty (never for caches); `retiredKeys` are a
 * renamed cache's old names, cleared on the next write. */
export interface StorageKeyDefinition extends StorageKeyBase, StorageKeyRef {}

/** A family of keys that share a prefix and differ by a suffix (a scope, an id). */
export interface StorageKeyFamilyDefinition extends StorageKeyBase {
  prefix: string
  /** What joins the prefix and the suffix; `.` unless an existing family used something else. */
  separator: string
  /** The full key for one suffix. */
  keyFor: (suffix: string) => string
  /** Former names of the key for one suffix, newest first. */
  legacyKeysFor: (suffix: string) => string[]
  /** Former names of a cache key for one suffix, cleared on the next write. */
  retiredKeysFor: (suffix: string) => string[]
  /** The concrete key for one suffix, with its former names. */
  at: (suffix: string) => StorageKeyRef
}

export type AnyStorageKeyDefinition = StorageKeyDefinition | StorageKeyFamilyDefinition

/** Every declaration seen so far, by its key or prefix. Re-declaring (a module reload) replaces. */
const registry = new Map<string, AnyStorageKeyDefinition>()

/** The grammar every fixed key follows (D-105): `printstream.<area>.<name>`; checked by each owner's test. */
export const STORAGE_KEY_GRAMMAR = /^printstream(\.[a-z][a-zA-Z0-9]*){2,}$/

/** A family's prefix needs only the area: its members' suffix (a scope, an id) completes the name. */
export const STORAGE_KEY_FAMILY_GRAMMAR = /^printstream(\.[a-z][a-zA-Z0-9]*){1,}$/

/**
 * Declares one fixed key.
 *
 * @param definition `legacyKeys` for a renamed preference, record or flow key; `retiredKeys` for a
 *   renamed cache.
 */
export function defineStorageKey(definition: StorageKeyBase & {
  key: string
  legacyKeys?: readonly string[]
  retiredKeys?: readonly string[]
}): StorageKeyDefinition {
  const declared: StorageKeyDefinition = {
    ...definition,
    legacyKeys: definition.kind === 'cache' ? [] : definition.legacyKeys ?? [],
    retiredKeys: definition.retiredKeys ?? []
  }
  registry.set(declared.key, declared)
  return declared
}

/**
 * Declares a family of keys, `<prefix><separator><suffix>`.
 *
 * @param definition `legacyPrefixes` for a family whose old keys differ only by prefix (the common
 *   case); `legacyKeysFor` when an old key was shaped differently. Caches use `retiredPrefixes`.
 */
export function defineStorageKeyFamily(definition: StorageKeyBase & {
  prefix: string
  separator?: string
  legacyPrefixes?: readonly string[]
  legacyKeysFor?: (suffix: string) => string[]
  retiredPrefixes?: readonly string[]
}): StorageKeyFamilyDefinition {
  const separator = definition.separator ?? '.'
  const legacyPrefixes = definition.legacyPrefixes ?? []
  const retiredPrefixes = definition.retiredPrefixes ?? []
  const keyFor = (suffix: string): string => `${definition.prefix}${separator}${suffix}`
  const legacyKeysFor = (suffix: string): string[] => {
    if (definition.kind === 'cache') return []
    if (definition.legacyKeysFor) return definition.legacyKeysFor(suffix)
    return legacyPrefixes.map((prefix) => `${prefix}${separator}${suffix}`)
  }
  const retiredKeysFor = (suffix: string): string[] => retiredPrefixes.map((prefix) => `${prefix}${separator}${suffix}`)
  const declared: StorageKeyFamilyDefinition = {
    storage: definition.storage,
    kind: definition.kind,
    owner: definition.owner,
    prefix: definition.prefix,
    separator,
    keyFor,
    legacyKeysFor,
    retiredKeysFor,
    at: (suffix) => ({
      key: keyFor(suffix),
      storage: definition.storage,
      legacyKeys: legacyKeysFor(suffix),
      retiredKeys: retiredKeysFor(suffix)
    })
  }
  registry.set(declared.prefix, declared)
  return declared
}

/** Every declared key and family, for a "reset this device" action (CONF-4) and for tests. */
export function listStorageKeyDefinitions(): readonly AnyStorageKeyDefinition[] {
  return [...registry.values()]
}

/** The browser store for an area, or `null` where storage is unavailable (SSR, blocked). */
function storageFor(area: BrowserStorageArea): Storage | null {
  try {
    // `window` in the browser; `globalThis` where a test or worker provides the stores without one.
    const host = (typeof window === 'undefined' ? globalThis : window) as { localStorage?: Storage; sessionStorage?: Storage }
    return (area === 'local' ? host.localStorage : host.sessionStorage) ?? null
  } catch {
    return null
  }
}

/** Reads a declared key (see `readStorageItem`). */
export function readStoredValue(ref: StorageKeyRef): string | null {
  return readStorageItem(ref.storage, ref.key, ref.legacyKeys)
}

/** Writes a declared key (see `writeStorageItem`). */
export function writeStoredValue(ref: StorageKeyRef, value: string): void {
  writeStorageItem(ref.storage, ref.key, value, ref.retiredKeys)
}

/** Removes a declared key and its former names (see `removeStorageItem`). */
export function removeStoredValue(ref: StorageKeyRef): void {
  removeStorageItem(ref.storage, ref.key, [...ref.legacyKeys, ...ref.retiredKeys])
}

/**
 * Reads a key, falling back to its former names while it is empty.
 *
 * Best-effort: unavailable storage reads as `null`. The legacy entry is left in place, as
 * `useLocalStorageState` does, because another tab on the previous build may still read it.
 */
function readStorageItem(storage: BrowserStorageArea, key: string, legacyKeys: readonly string[] = []): string | null {
  const store = storageFor(storage)
  if (!store) return null
  try {
    const current = store.getItem(key)
    if (current != null) return current
    for (const legacy of legacyKeys) {
      const value = store.getItem(legacy)
      if (value != null) return value
    }
    return null
  } catch {
    return null
  }
}

/**
 * Writes a key, and clears a renamed cache's old entries. Best-effort, like the read.
 */
function writeStorageItem(storage: BrowserStorageArea, key: string, value: string, retiredKeys: readonly string[] = []): void {
  const store = storageFor(storage)
  if (!store) return
  try {
    store.setItem(key, value)
    for (const retired of retiredKeys) store.removeItem(retired)
  } catch {
    /* Storage is optional: a full or blocked store leaves the app working without it. */
  }
}

/**
 * Removes a key and its former names, so a cleared value cannot reappear from a legacy entry.
 */
function removeStorageItem(storage: BrowserStorageArea, key: string, legacyKeys: readonly string[] = []): void {
  const store = storageFor(storage)
  if (!store) return
  try {
    store.removeItem(key)
    for (const legacy of legacyKeys) store.removeItem(legacy)
  } catch {
    /* Best effort, as above. */
  }
}
