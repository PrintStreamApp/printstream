/**
 * One in-flight fetch, and one cached answer, per built-in preset the public editor resolves.
 *
 * WHY: the anonymous `/api/public/slicing/resolve-*` endpoints answer from the slicer IMAGE, so a
 * built-in preset's config is a pure function of `(presetId, targetId)` and cannot change while the
 * tab is open. It was nonetheless re-fetched constantly — the per-material badge, the repair, the
 * save's authoring pass and `flattenLocalPreset`'s parent lookup each resolve independently, and
 * every material of a project sharing one preset resolved it once per slot. MEASURED on opening a
 * three-material project: nine `resolve-filament` round trips where three distinct presets were
 * involved, several of them concurrent duplicates of each other.
 *
 * DEDUPLICATION IS THE POINT, not just caching. The promise is stored, not the value, so callers
 * that ask at the same moment share one request rather than racing several identical ones — the
 * common case here, since a project's slots resolve in parallel.
 *
 * NOT CACHED: anything that depends on the user's browser-stored presets or on the open project.
 * Those change under the tab (the "Manage" dialog writes them, the editor edits the project), and a
 * stale answer there is a wrong answer. `refreshSlicingPresets` deliberately does NOT clear this —
 * uploading a preset cannot change what a BUILT-IN resolves to.
 *
 * A REJECTED lookup is evicted so a transient failure does not poison the tab for its lifetime.
 *
 * Scoped per editor session (`createBuiltinPresetCache`) rather than module-global, so closing a
 * project releases it and tests do not share state.
 */

/** Resolves one built-in preset. Injected so each kind keeps its own endpoint and response type. */
export type BuiltinPresetFetch<T> = (presetId: string, targetId: string | null) => Promise<T>

export interface BuiltinPresetCache {
  /** Wrap a fetcher so repeat and concurrent lookups of the same preset share one request. */
  memoize<T>(kind: string, fetcher: BuiltinPresetFetch<T>): BuiltinPresetFetch<T>
  /** Entries currently held, for assertions and diagnostics. */
  size(): number
}

export function createBuiltinPresetCache(): BuiltinPresetCache {
  const entries = new Map<string, Promise<unknown>>()
  return {
    memoize<T>(kind: string, fetcher: BuiltinPresetFetch<T>): BuiltinPresetFetch<T> {
      return (presetId, targetId) => {
        // `targetId` is part of the identity: the same preset name resolves differently against a
        // different slicer version, which is exactly what a version switch is for.
        const key = `${kind}\u0000${presetId}\u0000${targetId ?? ''}`
        const existing = entries.get(key)
        if (existing) return existing as Promise<T>
        const pending = fetcher(presetId, targetId).catch((error: unknown) => {
          entries.delete(key)
          throw error
        })
        entries.set(key, pending)
        return pending
      }
    },
    size: () => entries.size
  }
}
