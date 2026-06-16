/**
 * Minimal ambient declaration for `occt-import-js` (no types are shipped upstream).
 * Only the subset we use — instantiating the WASM module and reading STEP files — is declared.
 */
declare module 'occt-import-js' {
  interface OcctMeshAttributeArray {
    array: number[]
  }

  interface OcctMesh {
    name?: string
    attributes: {
      position: OcctMeshAttributeArray
      normal?: OcctMeshAttributeArray
    }
    index: OcctMeshAttributeArray
  }

  interface OcctReadResult {
    success: boolean
    meshes: OcctMesh[]
  }

  /**
   * Triangulation parameters for the readers. `null` selects occt-import-js's own
   * defaults (a `bounding_box_ratio` linear deflection of 0.001), which facets curved
   * surfaces on larger parts — pass explicit values for predictable quality.
   */
  export interface OcctTriangulationParams {
    linearUnit?: 'millimeter' | 'centimeter' | 'meter' | 'inch' | 'foot'
    linearDeflectionType?: 'bounding_box_ratio' | 'absolute_value'
    /** Chord error: a ratio of the bounding box, or an absolute value in `linearUnit`. */
    linearDeflection?: number
    /** Maximum angle (radians) between adjacent facet normals on curved surfaces. */
    angularDeflection?: number
  }

  interface OcctInstance {
    ReadStepFile(content: Uint8Array, params: OcctTriangulationParams | null): OcctReadResult
    ReadBrepFile(content: Uint8Array, params: OcctTriangulationParams | null): OcctReadResult
    ReadIgesFile(content: Uint8Array, params: OcctTriangulationParams | null): OcctReadResult
  }

  /** Default export instantiates the WASM module (optionally with an Emscripten module config). */
  export default function occtimportjs(moduleConfig?: Record<string, unknown>): Promise<OcctInstance>
}
