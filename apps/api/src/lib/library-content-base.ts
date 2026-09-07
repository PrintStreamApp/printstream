/**
 * Which library BYTES an editor session authors from, for every consumer of its `SceneEdit`.
 *
 * Owns one rule: a `SceneEdit` is a diff against the file the session OPENED, so every bake of
 * that edit must read the same bytes. The editor pins them at open (`contentBasePin.ts` in the web
 * app) and keeps sending the pin; this resolves it to something `resolveLibraryFileToLocalPath`
 * can read.
 *
 * Shared by the editor save/export routes and by slicing, deliberately: a slice that baked from
 * the file's CURRENT content instead re-applied an already-applied edit, because a save advances
 * the file head while the session's edit still describes the pre-save bytes. Its non-idempotent
 * members (`partOrder`, `removedParts`) then applied twice, which silently permuted an object's
 * parts and left the per-part `extruder` values behind on their old positions: parts traded
 * materials and a two-colour plate printed inverted. Slicing and saving must resolve their base
 * through THIS function so the two can never diverge again.
 *
 * Workspace-scoped like every other library lookup, but deliberately NOT scoped to the caller's
 * target file: the whole point of the pin is that the two can diverge (after a "save as" the
 * session keeps authoring from the ORIGINAL file's bytes while writing to a new file), which a
 * target-scoped version lookup would reject.
 */
import { prisma } from './prisma.js'
import { notFound } from './http-error.js'

/** The pin as it crosses the wire; mirrors `contentBase` in the shared slicing schema. */
export interface LibraryContentBase {
  fileId: string
  /** Null/absent means that file's CURRENT content, which is still what we opened until our first save. */
  versionId?: string | null
}

/**
 * Resolve a pinned content base to the row holding its bytes.
 *
 * A pin that no longer resolves is a HARD error, never a silent fall back to the target's current
 * content: falling back is precisely the behaviour the pin exists to prevent, and it would fail as
 * a wrong-looking print rather than as an error.
 */
export async function resolvePinnedContentBase(
  workspaceId: string,
  contentBase: LibraryContentBase
): Promise<{ ownerBridgeId: string | null; storedPath: string }> {
  if (contentBase.versionId) {
    const version = await prisma.libraryFileVersion.findFirst({
      where: { id: contentBase.versionId, workspaceId, libraryFileId: contentBase.fileId },
      select: { ownerBridgeId: true, storedPath: true }
    })
    if (!version) throw notFound('The version this project was opened from is no longer available')
    return version
  }
  const file = await prisma.libraryFile.findFirst({
    where: { id: contentBase.fileId, workspaceId },
    select: { ownerBridgeId: true, storedPath: true }
  })
  if (!file) throw notFound('The file this project was opened from is no longer available')
  return file
}
