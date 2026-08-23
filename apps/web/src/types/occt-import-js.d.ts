/**
 * Minimal ambient declaration for `occt-import-js` (no types are shipped upstream).
 *
 * Deliberately smaller than the api's (`apps/api/src/types/occt-import-js.d.ts`): the browser only
 * ever instantiates the module and reads STEP, and the RESULT shape is already described
 * structurally by `@printstream/shared/three-mf` (`OcctReadResult`), which both hosts fold through.
 * So the read is typed `unknown` here and narrowed at the one call site: the part that matters is
 * not declared twice, and the two stubs cannot drift on it.
 *
 * `moduleConfig` is Emscripten's: the web passes `locateFile` so the bundler-fingerprinted `.wasm`
 * is found (see `lib/localStepImport.ts`).
 */
declare module 'occt-import-js' {
  interface OcctInstance {
    ReadStepFile(content: Uint8Array, params: unknown): unknown
  }

  export default function occtimportjs(moduleConfig?: { locateFile?: () => string }): Promise<OcctInstance>
}
