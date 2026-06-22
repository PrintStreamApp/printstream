/**
 * Pure undo/redo + dirty-tracking state machine for the 3MF project editor.
 *
 * Framework-free so it can be unit-tested in isolation; the React wrapper lives in
 * useEditorHistory.ts. The machine owns the undo/redo stacks and decides whether the
 * project has unsaved changes; it does NOT know how to restore a scene — the caller
 * injects an `applyAndInvert` callback that performs the restore and returns the
 * inverse entry for the opposite stack.
 *
 * Dirtiness has two independent sources:
 * - **Undoable edits** (scene transforms, material add/remove, per-object/part
 *   overrides) advance a monotonic version id. The project is dirty while the
 *   current version differs from the version at the last save. Because version ids
 *   are never reused, undoing every edit back to the saved checkpoint returns the
 *   current version to the saved one and the project reads clean again — and a new
 *   edit after undoing always gets a fresh id, so branching never collides into a
 *   false "clean".
 * - **Non-undoable edits** (material profile/colour/nozzle changes, which are not
 *   snapshotted) set a sticky flag that only clears on save, since undo cannot
 *   reverse them.
 */
import { type EditorHistoryEntry } from './editorGeometry'

/** A stack frame: the captured state to restore, tagged with the version it represents. */
interface HistoryFrame {
  entry: EditorHistoryEntry
  version: number
}

/** Applies a restore for `entry` (side effect) and returns the inverse entry for the opposite stack. */
export type ApplyAndInvert = (entry: EditorHistoryEntry) => EditorHistoryEntry

export class EditorHistoryModel {
  private past: HistoryFrame[] = []
  private future: HistoryFrame[] = []
  /** Monotonic source of version ids; never decreases, so ids are never reused. */
  private versionCounter = 0
  /** Version id of the current document state. */
  private currentVersion = 0
  /** Version id captured at the last save (0 = the freshly loaded/seeded state). */
  private savedVersion = 0
  /** Sticky flag for edits undo cannot reverse; cleared only on save. */
  private nonUndoableDirty = false

  constructor(private readonly limit = 100) {}

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  get isDirty(): boolean {
    return this.nonUndoableDirty || this.currentVersion !== this.savedVersion
  }

  /**
   * Record an undoable checkpoint. `entry` captures the state being left (so undo can
   * restore it); recording advances the version and discards the redo stack.
   */
  record(entry: EditorHistoryEntry): void {
    this.past.push({ entry, version: this.currentVersion })
    if (this.past.length > this.limit) this.past.shift()
    this.versionCounter += 1
    this.currentVersion = this.versionCounter
    this.future = []
  }

  /** Flag a non-undoable edit dirty until the next save. */
  markNonUndoableDirty(): void {
    this.nonUndoableDirty = true
  }

  /** Undo the last checkpoint via `applyAndInvert`; returns false if there is nothing to undo. */
  undo(applyAndInvert: ApplyAndInvert): boolean {
    const frame = this.past.pop()
    if (!frame) return false
    const leavingVersion = this.currentVersion
    const inverse = applyAndInvert(frame.entry)
    this.future.push({ entry: inverse, version: leavingVersion })
    this.currentVersion = frame.version
    return true
  }

  /** Redo the last undone checkpoint via `applyAndInvert`; returns false if there is nothing to redo. */
  redo(applyAndInvert: ApplyAndInvert): boolean {
    const frame = this.future.pop()
    if (!frame) return false
    const leavingVersion = this.currentVersion
    const inverse = applyAndInvert(frame.entry)
    this.past.push({ entry: inverse, version: leavingVersion })
    this.currentVersion = frame.version
    return true
  }

  /** Mark the current state as saved: clears non-undoable dirtiness and the version delta. */
  markSaved(): void {
    this.savedVersion = this.currentVersion
    this.nonUndoableDirty = false
  }
}
