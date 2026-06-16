/**
 * Optional client-side model thumbnail providers.
 *
 * Core library rows render `FileThumbnail`, which can only show the server's
 * PNG thumbnails for 3MF/gcode files. Raw-mesh files (STL and STEP) carry no
 * embedded image, so the model-studio plugin (which owns Three.js) registers a
 * provider here that renders a small preview on the client (STEP is tessellated
 * to STL by the server first). Core stays free of Three.js: when no plugin
 * registers a provider, those files simply fall back to their kind label.
 *
 * The provider is registered once from the plugin's `init` hook, before the
 * React tree mounts, so consumers can read it synchronously at render time.
 */
import type { LibraryFile } from '@printstream/shared'

/** Resolves to a PNG data URL for a raw-mesh (STL/STEP) file, or `null` if a preview can't be produced. */
export type MeshThumbnailProvider = (file: LibraryFile, signal?: AbortSignal) => Promise<string | null>

let provider: MeshThumbnailProvider | null = null

/** Register the renderer used to preview raw-mesh (STL/STEP) files. Called once by the model-studio plugin. */
export function registerMeshThumbnailProvider(fn: MeshThumbnailProvider): void {
  provider = fn
}

/** The registered raw-mesh (STL/STEP) thumbnail renderer, or `null` when no plugin provides one. */
export function getMeshThumbnailProvider(): MeshThumbnailProvider | null {
  return provider
}

/**
 * Optional client-side fallback renderer for 3MF/gcode files whose SERVER thumbnail is
 * missing (e.g. a sliced gcode.3mf where BambuStudio's headless slice didn't embed a
 * plate PNG). The model-studio plugin registers one that renders the file at Bambu's
 * iso angle (no plate); `FileThumbnail` calls it only after the server thumbnail fails.
 */
export type SceneThumbnailProvider = (fileId: string, plate: number, signal?: AbortSignal) => Promise<string | null>

let sceneProvider: SceneThumbnailProvider | null = null

/** Register the client-side 3MF/gcode thumbnail fallback renderer. */
export function registerSceneThumbnailProvider(fn: SceneThumbnailProvider): void {
  sceneProvider = fn
}

/** The registered 3MF/gcode fallback renderer, or `null` when no plugin provides one. */
export function getSceneThumbnailProvider(): SceneThumbnailProvider | null {
  return sceneProvider
}
