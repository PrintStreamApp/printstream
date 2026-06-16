/**
 * Barrel for the shared 3MF index parser, published to consumers as
 * `@printstream/shared/three-mf`. This is the single source of truth for parsing a Bambu 3MF's
 * slice-info / model-settings / project-settings entries into the typed `BridgeLibraryThreeMfIndex`
 * the web sees. Both the API (`apps/api/src/lib/three-mf-reader.ts`) and the bridge
 * (`apps/bridge/src/library-3mf.ts`) feed it raw entries and own their own ZIP I/O and caching.
 *
 * Kept out of the main `@printstream/shared` barrel (its own subpath) so the web bundle never pulls
 * it in.
 */
export * from './index-parser.js'
