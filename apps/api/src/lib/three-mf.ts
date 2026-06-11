/**
 * 3MF (Bambu flavor) read/write — public API barrel.
 *
 * The implementation is decomposed into focused modules with one-way dependencies
 * (output/scene-builder -> reader -> internal, so there is no import cycle):
 *  - `three-mf-internal.ts`     — shared scaffolding: ZIP I/O, abort helpers, XML/regex escaping,
 *                                 and the generic `rewriteModelSettingsThreeMf` copy pass.
 *  - `three-mf-reader.ts`       — parse a 3MF into typed index/scene structures ({@link readPlateIndex},
 *                                 {@link readSceneManifest}). This is the half mirrored on the bridge
 *                                 (`apps/bridge/src/library-3mf.ts`); see that file's header for the
 *                                 index-shape mirror invariant.
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
  filterModelSettingsObjectsXml,
  readPlateObjectsWithPreview
} from './three-mf-output.js'
export type { ObjectProcessOverrides } from './three-mf-output.js'
