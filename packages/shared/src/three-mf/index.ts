/**
 * Barrel for the shared 3MF parsers, published to consumers as `@printstream/shared/three-mf`.
 * These are the single source of truth for turning a Bambu 3MF's already-unzipped entries into
 * typed structures; every consumer owns its own ZIP I/O and caching.
 *
 * - `index-parser.ts`: slice-info / model-settings / project-settings → `BridgeLibraryThreeMfIndex`
 *   (what plates and filaments the project has). Used by the API
 *   (`apps/api/src/lib/three-mf-reader.ts`) and the bridge (`apps/bridge/src/library-3mf.ts`).
 * - `scene-parser.ts`: root model / model-settings → `ThreeMfScene` (where every object sits on a
 *   plate). Used by the API's `readSceneManifest` and by the web's public 3MF editor, which unzips
 *   in the browser so the file never leaves the user's machine.
 *
 * The 3MF *writer* lives here for the same reason. `bake.ts` is the entry point, it says which
 * source entries a bake reads (with their size caps) and returns a PLAN of entry rewrites for the
 * caller to apply. `bake-documents.ts` beneath it is the whole bake as pure document transforms, mesh injection, build-item and plate regeneration, per-part edits, and the
 * `project_settings.config` rewrites, with `object-clone.ts` (independent object copies),
 * `mesh-repair.ts` (the admesh-equivalent weld/prune the editor applies on request), and
 * `xml-write.ts` (attribute escaping) beneath it. Nothing here touches an archive: each consumer
 * supplies the entry text and writes the result with its own ZIP layer, which is what lets the api
 * bake a file on disk and the browser bake the user's own file without uploading it.
 *
 * Kept out of the main `@printstream/shared` barrel (its own subpath) so the web bundle only pulls
 * it into the chunks that actually parse a 3MF.
 */
export * from './bake-documents.js'
export * from './bake.js'
export * from './embedded-presets.js'
export * from './entries.js'
export * from './imported-mesh.js'
export * from './index-dto.js'
export * from './index-parser.js'
export * from './scene-parser.js'
export * from './mesh-repair.js'
export * from './mesh-stl.js'
export * from './mesh-extract.js'
export * from './step-mesh.js'
export * from './object-overrides.js'
export * from './object-clone.js'
export * from './triangle-paint-codec.js'
export * from './xml-write.js'
