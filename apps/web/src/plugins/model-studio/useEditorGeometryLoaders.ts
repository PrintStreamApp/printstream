/**
 * Load and cache source-part and staged-import geometry for the editor scene.
 * Cache refs stay owned by EditorView and are disposed by useEditorScene on
 * teardown. A shared fetch has no build-specific abort signal: superseding
 * scene builds cancel their own consumption without cancelling a newer build.
 */
import { useCallback, type MutableRefObject } from 'react'
import {
  evictGeometryCache,
  GEOMETRY_CACHE_MAX_ENTRIES,
  touchCacheEntry,
  type GeometryCache,
  type ImportGeometryCache
} from './editorGeometry.js'
import type { EditorImportStore } from './lib/editorImportStore.js'
import type { EditorProjectSource } from './lib/editorProjectSource.js'
import { parseStlGeometryAsync, parseThreeMfModelEntryAsync } from './lib/meshParseClient.js'

/** Return stable geometry loaders for the session's source and import stores. */
export function useEditorGeometryLoaders(
  projectSource: EditorProjectSource,
  importStore: EditorImportStore,
  geometryCacheRef: MutableRefObject<GeometryCache>,
  importGeometryCacheRef: MutableRefObject<ImportGeometryCache>
) {
  // NOTE: cache-owned fetches deliberately take no AbortSignal. The promise is shared
  // across builds (prefetch + sequential assembly, superseding rebuilds), so tying it
  // to one build's signal let that build's teardown abort a fetch a NEWER build was
  // awaiting: the model never appeared and the AbortError surfaced as an error toast.
  // Builds cancel by checking their own `cancelled` flag after each await; a fetch
  // that outlives every consumer just completes into the cache (or evicts on failure).
  const fetchGeometry = useCallback((entryPath: string) => {
    const cache = geometryCacheRef.current
    const existing = cache.get(entryPath)
    if (existing) {
      touchCacheEntry(cache, entryPath, existing)
      return existing
    }
    const promise = (async () => {
      // Stall-guarded read: a wedged transport that commits a response then hangs mid-body
      // must fail loudly (so the viewport shows an error/retry) rather than freeze the build.
      const bytes = await projectSource.loadEntry(entryPath)
      // Parse + process off the main thread (worker pool) so a huge object (50MB+ of mesh XML)
      // doesn't freeze the editor while it builds: falls back to a main-thread parse on worker error.
      return parseThreeMfModelEntryAsync(bytes)
    })()
    cache.set(entryPath, promise)
    evictGeometryCache(cache, GEOMETRY_CACHE_MAX_ENTRIES, (map) => { for (const geometry of map.values()) geometry.dispose() })
    // A failed load must not poison the cache for the next attempt.
    promise.catch(() => {
      if (cache.get(entryPath) === promise) cache.delete(entryPath)
    })
    return promise
  }, [geometryCacheRef, projectSource])

  const fetchImportGeometry = useCallback((importId: string, partIndex?: number) => {
    const cache = importGeometryCacheRef.current
    // A multi-solid import fetches each solid separately; cache them under distinct keys.
    const cacheKey = partIndex == null ? importId : `${importId}#${partIndex}`
    const existing = cache.get(cacheKey)
    if (existing) {
      touchCacheEntry(cache, cacheKey, existing)
      return existing
    }
    const promise = (async () => {
      const buffer = await importStore.fetchMesh(importId, partIndex)
      // Parse off the main thread (worker pool); falls back to a main-thread parse on worker error.
      return parseStlGeometryAsync(new Uint8Array(buffer))
    })()
    cache.set(cacheKey, promise)
    evictGeometryCache(cache, GEOMETRY_CACHE_MAX_ENTRIES, (geometry) => geometry.dispose())
    promise.catch(() => {
      if (cache.get(cacheKey) === promise) cache.delete(cacheKey)
    })
    return promise
  }, [importGeometryCacheRef, importStore])

  return { fetchGeometry, fetchImportGeometry }
}
