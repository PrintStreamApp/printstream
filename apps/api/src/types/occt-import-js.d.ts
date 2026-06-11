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

  interface OcctInstance {
    ReadStepFile(content: Uint8Array, params: unknown): OcctReadResult
    ReadBrepFile(content: Uint8Array, params: unknown): OcctReadResult
    ReadIgesFile(content: Uint8Array, params: unknown): OcctReadResult
  }

  /** Default export instantiates the WASM module (optionally with an Emscripten module config). */
  export default function occtimportjs(moduleConfig?: Record<string, unknown>): Promise<OcctInstance>
}
