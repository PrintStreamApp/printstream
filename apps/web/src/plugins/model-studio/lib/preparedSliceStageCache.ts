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
>

/** Retain only the semantic inputs that determine the staged project bytes and proof. */
export function preparedSliceStageIdentity(input: StageSnapshotInput): PreparedSliceStageIdentity {
  return {
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
