/**
 * Bounded-volume-hierarchy acceleration for the paint brush's hit test.
 *
 * WHY. Painting raycasts the selected object on every pointer move, and three.js's stock
 * `Mesh.raycast` walks EVERY triangle of the mesh each time. A CPU profile of ten paint strokes put
 * ~14% of all samples in that walk (`intersectTriangle`, `getVertexPosition`, `checkGeometryIntersection`
 * and friends) -- the single largest cost in the paint path, and the reason the brush felt equally
 * sluggish in every channel: it is the shared hit test, not any one channel's overlay.
 *
 * WHAT IT DOES. `three-mesh-bvh` replaces that linear walk with a tree descent, and installs itself
 * by patching three's prototypes. The patch is global and deliberate: `acceleratedRaycast` falls
 * back to the stock implementation for any geometry with no `boundsTree`, so meshes we never index
 * behave exactly as before.
 *
 * WHAT IT COSTS. Building a tree is not free (roughly a sort over the triangles) and it holds memory
 * for the life of the geometry, so trees are built LAZILY -- on the first paint hit test against a
 * mesh, not when the scene is built. A session that never paints pays nothing, which matters
 * because a plate can hold a hundred objects and only one is ever painted at a time.
 *
 * DISPOSAL IS NOT OPTIONAL. The tree is stored ON the geometry, so it outlives the mesh unless it is
 * released with it; the editor already disposes geometries through `disposeObject3D`, and this hooks
 * the same seam. Leaking here would be invisible until a long editing session ran the tab out of
 * memory.
 */
import * as THREE from 'three'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'

let installed = false

/**
 * Patch three's prototypes once per session.
 *
 * Idempotent because both the editor and the read-only preview mount this plugin's scene code, and
 * re-assigning the prototype methods on every mount is pointless work on a hot path everything else
 * in the app also raycasts through.
 */
export function installMeshBvh(): void {
  if (installed) return
  installed = true
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const geometry = THREE.BufferGeometry.prototype as any
  geometry.computeBoundsTree = computeBoundsTree
  geometry.disposeBoundsTree = disposeBoundsTree
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(THREE.Mesh.prototype as any).raycast = acceleratedRaycast
}

/**
 * Ensure `mesh`'s geometry carries a BVH, building one the first time.
 *
 * Safe to call per pointer move: the second call onward is a property check. Returns false when the
 * geometry cannot be indexed (no position attribute), so the caller can carry on with the stock
 * raycast rather than treating it as an error -- an unindexable mesh is slow, not broken.
 */
export function ensureMeshBvh(mesh: THREE.Mesh): boolean {
  installMeshBvh()
  const geometry = mesh.geometry as THREE.BufferGeometry & {
    boundsTree?: unknown
    computeBoundsTree?: (options?: { indirect?: boolean }) => void
  }
  if (geometry.boundsTree) return true
  if (!geometry.getAttribute?.('position')) return false
  try {
    // `indirect: true` IS THE WHOLE CONTRACT HERE, not a tuning knob. The default build calls
    // `ensureIndex`, which does `geometry.setIndex(...)` on a non-indexed geometry -- and every
    // paint mesh in this editor is deliberately non-indexed, because triangle N is addressed as
    // positions 3N..3N+2 by the paint codes, the overlay builder and the 3MF writer alike.
    // `buildTrianglePaintOverlay` bails out the moment `geometry.index` exists, so an indexed
    // build silently turned painting into a no-op: the brush ran, state updated, and nothing
    // ever drew. Indirect mode keeps its own primitive ordering and leaves the geometry alone.
    geometry.computeBoundsTree?.({ indirect: true })
    if (geometry.index) {
      // Belt and braces: if a future version indexes anyway, drop the tree rather than leave a
      // mesh that cannot render its paint. Slow beats silently broken.
      disposeMeshBvh(geometry)
      geometry.setIndex(null)
      return false
    }
    return Boolean(geometry.boundsTree)
  } catch {
    // A degenerate mesh can defeat the builder. Falling back to the stock raycast keeps painting
    // working (slowly) rather than failing the stroke, which is the behaviour we had before.
    return false
  }
}

/** Release a geometry's BVH, if it has one. Call wherever the geometry itself is disposed. */
export function disposeMeshBvh(geometry: THREE.BufferGeometry): void {
  const withTree = geometry as THREE.BufferGeometry & { boundsTree?: unknown; disposeBoundsTree?: () => void }
  if (!withTree.boundsTree) return
  withTree.disposeBoundsTree?.()
}
