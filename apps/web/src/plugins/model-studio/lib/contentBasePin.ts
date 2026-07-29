/**
 * Which bytes an editor session authors its saves FROM.
 *
 * Owns one rule, because getting it wrong is invisible: the pin identifies **what we opened**, and
 * it may move exactly ONCE — from "that file's head" to the durable version id the first save
 * archives, which is the same bytes under a name that will not move again. Every later save
 * archives our OWN output, so adopting one of those would resume authoring each save from the
 * previous save's result, which is the chaining this exists to stop (one stranded mesh object per
 * solid per save on an import-backed project; see the shared save schema's `contentBase`).
 *
 * Counterpart: `resolvePinnedContentBase` in the API's editor route, which reads the pin without
 * scoping it to the save target — after a saveAs the session writes to a NEW file while still
 * authoring from the original's bytes.
 */

export interface EditorContentBasePin {
  fileId: string
  /** Null ⇒ that file's CURRENT content, which is still what we opened until our first save. */
  versionId: string | null
}

/**
 * The pin an editor session starts with: the file it opened, at the version it opened (null for
 * "current"). Null for a project with no base file at all — an editor-born project bakes from its
 * own state (`ignoreBaseContent`) and has no bytes to author from.
 */
export function initialContentBasePin(
  baseFileId: string | null,
  baseVersionId: string | null | undefined
): EditorContentBasePin | null {
  return baseFileId ? { fileId: baseFileId, versionId: baseVersionId ?? null } : null
}

/**
 * Fold a completed save's archived version into the pin.
 *
 * @param savedFileId the file the save landed on; an archived version belongs to it.
 * @param archivedVersionId the version that save archived, or null when it archived nothing
 *   (a save that created a new file, or a target without version history).
 * @returns the pin to keep. Unchanged unless this save archived the very bytes we opened.
 */
export function nextContentBasePin(
  current: EditorContentBasePin | null,
  savedFileId: string,
  archivedVersionId: string | null | undefined
): EditorContentBasePin | null {
  if (!current || !archivedVersionId) return current
  // Already pinned to a durable version: every further archive is of our own output.
  if (current.versionId !== null) return current
  // A save onto a DIFFERENT file (a saveAs) archived that file's content, not ours.
  if (current.fileId !== savedFileId) return current
  return { fileId: current.fileId, versionId: archivedVersionId }
}
