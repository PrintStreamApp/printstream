/**
 * Owns the editor viewport's two teardown boundaries that can outlive the React effect:
 * WebGL context loss and in-flight geometry loads. Callers release other listeners and scene
 * controllers first, then invoke these helpers before dropping their scene refs.
 */
import type * as THREE from 'three'
import type { GeometryCache, ImportGeometryCache } from '../editorGeometry'

/**
 * Unsubscribe context recovery before deliberately losing the context, then remove the canvas.
 * Browser context caps make waiting for canvas garbage collection unsafe on repeated editor opens.
 */
export function releaseEditorWebglCanvas(options: {
  releaseContextRecovery: () => void
  renderer: Pick<THREE.WebGLRenderer, 'dispose' | 'forceContextLoss' | 'domElement'>
  container: Pick<HTMLElement, 'removeChild'>
}): void {
  options.releaseContextRecovery()
  options.renderer.dispose()
  options.renderer.forceContextLoss()
  options.container.removeChild(options.renderer.domElement)
}

/**
 * Clear cache ownership now and dispose each resolved geometry once its pending load settles.
 * A failed load has no GPU resource to dispose, so rejection is intentionally ignored here.
 */
export function disposeEditorSceneCaches(
  geometryCache: GeometryCache,
  importGeometryCache: ImportGeometryCache
): void {
  for (const entry of geometryCache.values()) {
    void entry.then((map) => {
      for (const geometry of map.values()) geometry.dispose()
    }).catch(() => {})
  }
  geometryCache.clear()

  for (const entry of importGeometryCache.values()) {
    void entry.then((geometry) => geometry.dispose()).catch(() => {})
  }
  importGeometryCache.clear()
}
