/**
 * Vite's `?url` asset imports for the OpenCASCADE build.
 *
 * `vite/client` declares `*.wasm?url` only when its types are in scope for this file; declaring the
 * one specifier we import keeps the dynamic import in `lib/localStepImport.ts` typed without
 * widening every asset import in the app.
 */
declare module '*.wasm?url' {
  const src: string
  export default src
}
