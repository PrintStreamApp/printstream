/**
 * 3MF (Bambu flavor) read/write — public API barrel.
 *
 * The implementation is decomposed into focused modules with one-way dependencies
 * (output/scene-builder -> reader -> internal, so there is no import cycle):
 *  - `three-mf-internal.ts`     — shared scaffolding: ZIP I/O, abort helpers, XML/regex escaping,
 *                                 and the generic `rewriteModelSettingsThreeMf` copy pass.
 *  - `three-mf-reader.ts`       — parse a 3MF into typed index/scene structures ({@link readPlateIndex},
 *                                 {@link readSceneManifest}). The pure index parse is delegated to the
 *                                 shared `@printstream/shared/three-mf` module (the bridge uses it too),
 *                                 so the index logic is no longer duplicated; this module owns the ZIP
 *                                 I/O, caching, and the scene parse.
 *  - `three-mf-scene-builder.ts`— bake an editor arrangement (`SceneEdit`) into a 3MF
 *                                 ({@link buildEditedThreeMf}, {@link writeArrangedThreeMf}).
 *  - `three-mf-output.ts`       — slice-ready 3MF variants ({@link createSinglePlateThreeMf} and
 *                                 friends, {@link embedPlateThumbnails}) and reading sliced gcode/pick
 *                                 output ({@link readPlateObjectsWithPreview}).
 *
 * This module re-exports the stable public surface so existing importers keep working; prefer
 * importing from the focused modules in new code.
 */
export { readEntry } from './three-mf-internal.js'

export { buildThreeMfIndex, readPlateIndex, readPreviewAssets, readSceneManifest } from './three-mf-reader.js'
export type {
  ThreeMfExcludeZone,
  ThreeMfFilament,
  ThreeMfIndex,
  ThreeMfPlate,
  ThreeMfPlateObject,
  ThreeMfPreviewAsset,
  ThreeMfPrimeTower,
  ThreeMfPrimeTowerSizing,
  ThreeMfProjectFilament,
  ThreeMfScene,
  ThreeMfSceneBed,
  ThreeMfSceneInstance,
  ThreeMfSceneInstancePart,
  ThreeMfScenePart
} from './three-mf-reader.js'

export { buildEditedThreeMf, threeMfTransformFromTRS, writeArrangedThreeMf } from './three-mf-scene-builder.js'
export type { ImportedObjectInput } from './three-mf-scene-builder.js'

export {
  applyObjectProcessOverridesXml,
  buildPlateObjectsWithPreview,
  createObjectCustomizedThreeMf,
  createObjectFilteredThreeMf,
  createSinglePlateThreeMf,
  embedPlateThumbnails,
  plateObjectIdsFromModelSettingsXml,
  readPlateObjectsWithPreview,
  rekeyReplacedObjectOverrides,
  setBuildItemsUnprintableXml
} from './three-mf-output.js'
export type { ObjectProcessOverrides } from './three-mf-output.js'
