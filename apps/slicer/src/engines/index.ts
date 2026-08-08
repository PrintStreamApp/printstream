/**
 * Engine management, as a package entry point.
 *
 * Exported so a host that runs the slicer IN-PROCESS (the native self-hosted
 * app) can ensure an engine is present without going out to HTTP and back into
 * the same process. The HTTP routes in `../index.ts` are the same functions for
 * everyone else.
 */
export { listCatalogue, latestStableEngine, findCatalogueEngine, assetPlatformKey, needsSharedSysroot } from './catalogue.js'
export type { CatalogueEngine, EngineAsset } from './catalogue.js'
export { installEngine, removeEngine } from './install.js'
export type { EngineInstallProgress, InstallEngineOptions } from './install.js'
export { readInstalledEngineIds } from './manifest.js'
