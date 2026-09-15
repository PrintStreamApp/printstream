/**
 * The staged-import mesh contract: geometry handed to the 3MF writer to be baked into a project as
 * a new object.
 *
 * Types only: the producers are per-surface and stay where they are (the api's `mesh-import.ts`
 * parses STL and tessellates STEP through occt WASM; the browser will parse its own). What has to
 * be shared is the SHAPE, because the bake consumes it and the bake runs on both sides.
 *
 * Coordinates are millimetres in the source file's own space; the writer re-centres and places.
 */

/**
 * A refusal that describes the FILE rather than the runtime: unreadable, unsupported, or
 * self-contradictory input that will fail identically however many times it is parsed.
 *
 * EXISTS TO BE CAUGHT BY TYPE. The web's staging worker has to tell a data failure from a mechanism
 * failure, because a mechanism failure falls back to a main-thread re-parse and a data failure must
 * NOT (the retry freezes the tab on its way to the identical message). That test used to match on
 * message TEXT, which is a contract nobody can see: a parser throwing a message the pattern did not
 * list was silently misclassified, and so were the errors the parsers did not raise themselves --
 * `atob` on a malformed base64 buffer throws a `DOMException`, which in a browser is not even
 * `instanceof Error`. Every refusal a mesh parser raises is one of these, so the worker can ask
 * `instanceof` and be right by construction.
 *
 * The sibling for 3MF-specific refusals is `ThreeMfImportError` in `mesh-extract.ts`; the message
 * pattern survives only for third-party failures we do not raise (the OpenCASCADE WASM).
 */
export class ModelImportError extends Error {}

export interface ImportedMeshBounds {
  min: { x: number; y: number; z: number }
  max: { x: number; y: number; z: number }
}

export interface ImportedMesh {
  /** Flat vertex coordinates, 3 (x,y,z) per vertex. */
  positions: number[]
  /** Flat triangle vertex indices, 3 per triangle. */
  indices: number[]
  bounds: ImportedMeshBounds
  /**
   * Optional source RGBA values in TRIANGLE-CORNER order: four numbers for each entry in
   * `indices`. Alpha zero marks a corner whose source vertex had no colour. This deliberately does
   * not key by the welded vertex index, because two faces may share one geometric vertex while
   * assigning different colours at that corner. The colour-to-filament importer consumes this
   * sidecar to author `paint_color`; the 3MF geometry writer ignores it.
   */
  triangleCornerColors?: number[]
  /** Which source appearance supplied {@link triangleCornerColors}; used to describe the mapping UI. */
  sourceColorMode?: 'vertex' | 'material' | 'texture'
  /**
   * Individual named solids when the source held more than one (a multi-solid STEP
   * assembly). Each part is a self-contained mesh in the same coordinate space as the
   * merged geometry above, so the editor can render and the 3MF builder can bake them
   * as separate parts of one object. Absent (undefined) for single-solid STEP and STL,
   * where the merged mesh is the whole import.
   */
  parts?: ImportedMeshPart[]
}

export interface ImportedMeshPart {
  name: string
  mesh: ImportedMesh
  /**
   * Raw 3MF `subtype` when this solid is a HELPER volume (support blocker/enforcer, modifier,
   * negative part). Absent/null for printed geometry, and always so for STL/STEP, which have no
   * volume concept. Carried from the 3MF extractor to the bake so an imported blocker is written
   * back as a blocker (see `renderImportedMultiPartModelSettingsXml`).
   */
  subtype?: string | null
}
