/**
 * Client-side fallback thumbnail renderer for 3MF/gcode files.
 *
 * Used when a file has no embedded server thumbnail. It renders the plate's MODEL mesh in its
 * material colour at Bambu's iso angle with no plate surface (reusing the editor's offscreen
 * renderer), so the thumbnail looks like the part — matching a normal 3MF thumbnail. It never
 * falls back to a G-code toolpath render: a toolpath is a misleading "thumbnail", and sliced
 * outputs strip the mesh (--min-save) so a toolpath would otherwise be all that's left. Only
 * invoked after the server thumbnail fails, so files that already have one pay nothing.
 */
import type { LibraryThreeMfScene } from '@printstream/shared'
import { apiFetch } from '../../../lib/apiClient'
import { createPlateThumbnailRenderer } from './plateThumbnail'
import { buildThreeMfMeshGroup, disposeObject3D } from './threeMfScene'

// One shared offscreen renderer for all library thumbnails. Model-mesh thumbnails now render
// eagerly for every gcode file in a list, so creating/disposing a WebGL context per thumbnail
// would churn GL contexts (browsers cap how many are live). render() is synchronous, so a single
// shared renderer is safe to reuse across the (sequential) render calls.
let sharedRenderer: ReturnType<typeof createPlateThumbnailRenderer> | null = null

// Idle release: the shared renderer pins a live WebGL context (browsers cap live contexts
// at ~8-16 and evict the oldest past the cap), so drop it once the library view has gone
// quiet. The next fallback thumbnail simply recreates it.
const RENDERER_IDLE_DISPOSE_MS = 60_000
let rendererIdleTimer: ReturnType<typeof setTimeout> | null = null

function getSharedThumbnailRenderer() {
  if (!sharedRenderer) sharedRenderer = createPlateThumbnailRenderer()
  if (rendererIdleTimer) clearTimeout(rendererIdleTimer)
  rendererIdleTimer = setTimeout(() => {
    rendererIdleTimer = null
    sharedRenderer?.dispose()
    sharedRenderer = null
  }, RENDERER_IDLE_DISPOSE_MS)
  return sharedRenderer
}

/**
 * Render a library file's MODEL mesh (material colour, Bambu iso angle) to a PNG data URL, or
 * null if no mesh scene can be built. This is only the FALLBACK for `FileThumbnail` when a file
 * has no embedded plate PNG — and a thumbnail must look like the part, never the toolpath, so it
 * deliberately does NOT fall back to a G-code render (sliced outputs strip the mesh via
 * --min-save, which would otherwise leave only a misleading toolpath thumbnail).
 */
export async function renderLibraryFileThumbnail(fileId: string, plate: number, signal?: AbortSignal): Promise<string | null> {
  try {
    const scene = await apiFetch<LibraryThreeMfScene>(`/api/library/${fileId}/scene?plate=${plate}`, { signal })
    const group = await buildThreeMfMeshGroup(fileId, scene, signal)
    try {
      return getSharedThumbnailRenderer().render(group, scene.bed)
    } finally {
      disposeObject3D(group)
    }
  } catch {
    return null
  }
}
