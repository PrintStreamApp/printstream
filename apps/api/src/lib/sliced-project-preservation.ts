/**
 * Keeping the project a slice was produced from, so a finished print can be sliced again.
 *
 * Owns one step of the slicing pipeline: the project 3MF exactly as it was handed to the
 * engine: after every rewrite the pipeline applies (arranged scene, object selection,
 * per-object overrides, authored machine, the slice's own presets and overrides via
 * `slice-settings-authoring.ts`, mesh weld), before the slicer's own mechanical prep: is
 * stored as a hidden, content-deduped snapshot and recorded on the sliced OUTPUT row,
 * together with the settings that produced it.
 *
 * These are THE SLICED BYTES, not a reconstruction: the pipeline authors the slice's settings
 * into the project it hands the engine, so the file kept here is the file that was sliced.
 * Nothing in this module rewrites anything.
 *
 * Why the link lives on the output and not on the snapshot: snapshots are content-addressed
 * and shared between any two files with identical bytes, so they cannot carry per-slice
 * facts. `library-printing.ts` copies both fields onto the `PrintJob` at dispatch, which is
 * what makes the association survive the output being deleted.
 *
 * Counterpart on the web: `SliceThenPrintFlow`, which re-opens the preserved project in the
 * prepare-print dialog. Counterpart in cleanup: nothing, a snapshot row is never swept
 * (`library-cleanup.ts` skips rows with a `snapshotKey`), which is deliberate and is why
 * callers must only preserve a project whose output was actually persisted.
 */
import { stat } from 'node:fs/promises'
import type { PreservedSliceSettings } from '@printstream/shared'
import { ensureLibrarySnapshotFromLocalPath } from './print-file-snapshots.js'
import { prisma } from './prisma.js'

export interface PreserveSlicedProjectInput {
  workspaceId: string
  /** Display name for the preserved project: the source project's name, not the output's. */
  fileName: string
  /** Local path to the prepared project. Must still exist; the caller owns deleting it. */
  preparedProjectPath: string
  /** The persisted sliced output the link is recorded on. */
  output: { id: string; ownerBridgeId: string | null }
  settings: PreservedSliceSettings
}

/**
 * Store the prepared project and link it to its sliced output.
 *
 * Returns the preserved project's library file id, or null when the output is not
 * bridge-backed (local-file installs have nowhere to put the bytes). Throws only on real
 * storage/database failures; callers treat those as "this print cannot be re-sliced" rather
 * than as a failed slice.
 */
export async function preserveSlicedProject(input: PreserveSlicedProjectInput): Promise<string | null> {
  if (!input.output.ownerBridgeId) return null

  const info = await stat(input.preparedProjectPath)
  const snapshot = await ensureLibrarySnapshotFromLocalPath({
    workspaceId: input.workspaceId,
    ownerBridgeId: input.output.ownerBridgeId,
    fileName: input.fileName,
    sourcePath: input.preparedProjectPath,
    sizeBytes: info.size
  })
  await prisma.libraryFile.update({
    where: { id: input.output.id },
    data: {
      sourceProjectFileId: snapshot.id,
      sliceSettingsJson: JSON.stringify(input.settings)
    }
  })
  return snapshot.id
}
