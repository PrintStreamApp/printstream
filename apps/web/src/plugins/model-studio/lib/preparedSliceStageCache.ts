/**
 * Identity policy for reusing an immutable browser-prepared slicing project.
 *
 * The stage lifecycle callbacks are deliberately excluded: they affect progress UI, not the bytes
 * baked into the 3MF. Every field that can affect those bytes remains in the identity so a changed
 * scene, content base, object override, machine, process, filament, or slicer target stages again.
 */
import { deepEqual } from '@printstream/shared'
import type { StageSnapshotInput } from './editorSaveTarget'

export type PreparedSliceStageIdentity = Pick<StageSnapshotInput,
  | 'sceneEdit'
  | 'sourceFileId'
  | 'configurationBaseFileId'
  | 'configurationBaseVersionId'
  | 'objectProcessOverrides'
  | 'target'
  | 'slicerTargetId'
> & {
  /**
   * `slicingPresetRevision.ts`. The target names presets by id, and the bake resolves their
   * CONTENT, so an in-place preset update would otherwise reuse bytes baked from the old values.
   */
  presetRevision: number
}

/**
 * Retain only the semantic inputs that determine the staged project bytes and proof.
 *
 * @param presetRevision `currentSlicingPresetRevision()` read BEFORE staging, so a preset changed
 *   mid-bake makes the next slice stage again rather than reuse.
 */
export function preparedSliceStageIdentity(input: StageSnapshotInput, presetRevision: number): PreparedSliceStageIdentity {
  return {
    presetRevision,
    sceneEdit: input.sceneEdit,
    sourceFileId: input.sourceFileId,
    configurationBaseFileId: input.configurationBaseFileId,
    configurationBaseVersionId: input.configurationBaseVersionId,
    objectProcessOverrides: input.objectProcessOverrides,
    target: input.target,
    slicerTargetId: input.slicerTargetId
  }
}

/** Whether a prior prepared source represents exactly the project this slice would stage. */
export function canReusePreparedSliceStage(
  previous: PreparedSliceStageIdentity,
  current: PreparedSliceStageIdentity
): boolean {
  return deepEqual(previous, current)
}
