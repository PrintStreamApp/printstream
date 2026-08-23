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
