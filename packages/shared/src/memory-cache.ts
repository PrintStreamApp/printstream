/**
 * Small in-memory LRU cache with optional TTL.
 *
 * Disabled mode turns reads into misses and writes into no-ops so callers can
 * keep the same code path while opting out during development.
 */
export interface MemoryLruCacheOptions {
  maxEntries: number
  ttlMs?: number | null
  enabled?: boolean
  now?: () => number
}

interface MemoryLruCacheEntry<Value> {
  value: Value
  expiresAt: number | null
}

export class MemoryLruCache<Key, Value> {
  private readonly entries = new Map<Key, MemoryLruCacheEntry<Value>>()

  private readonly maxEntries: number

  private readonly ttlMs: number | null

  private readonly enabled: boolean

  private readonly now: () => number

  constructor(options: MemoryLruCacheOptions) {
    this.maxEntries = Math.max(1, Math.trunc(options.maxEntries))
    this.ttlMs = options.ttlMs != null ? Math.max(0, Math.trunc(options.ttlMs)) : null
    this.enabled = options.enabled !== false
    this.now = options.now ?? Date.now
  }

  get(key: Key): Value | undefined {
    if (!this.enabled) return undefined
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt != null && entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: Key, value: Value): void {
    if (!this.enabled) return
    this.pruneExpired()
    if (this.entries.has(key)) this.entries.delete(key)
    this.entries.set(key, {
      value,
      expiresAt: this.ttlMs != null ? this.now() + this.ttlMs : null
    })
    this.pruneOverflow()
  }

  delete(key: Key): void {
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    this.pruneExpired()
    return this.entries.size
  }

  private pruneExpired(): void {
    if (this.ttlMs == null) return
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt != null && entry.expiresAt <= now) this.entries.delete(key)
    }
  }

  private pruneOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey == null) return
      this.entries.delete(oldestKey)
    }
  }
}