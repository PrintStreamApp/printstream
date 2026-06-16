/**
 * Drag-and-drop payload contract for moving library files/folders.
 *
 * A drag carries a JSON blob on the `LIBRARY_DRAG_MIME` data-transfer type
 * describing the dragged item by id (plus an inline snapshot as a fallback).
 * The same blob is produced by the source surface (`serializeLibraryDragItem`)
 * and read back by the drop target (`parseLibraryDragItem`).
 *
 * `parseLibraryDragItem` re-resolves the dragged ids against the *caller's*
 * current `files`/`folders` so the drop acts on the live row objects; it falls
 * back to the inline snapshot embedded in the blob when the id is no longer
 * present in the caller's lists. Callers that have the live in-memory drag item
 * (a same-document drag) should prefer that and only fall back to this parser
 * for cross-surface drags where the blob is all they have.
 */
import type { LibraryFile, LibraryFolder } from '@printstream/shared'

export const LIBRARY_DRAG_MIME = 'application/x-printstream-library-item'

export type LibraryDragItem =
  | { type: 'file'; file: LibraryFile }
  | { type: 'files'; files: LibraryFile[] }
  | { type: 'folder'; folder: LibraryFolder }

type SerializedLibraryDragItem =
  | { type: 'file'; id: string; file: LibraryFile }
  | { type: 'files'; ids: string[]; files: LibraryFile[] }
  | { type: 'folder'; id: string; folder: LibraryFolder }

type ParsedLibraryDragItem = {
  type?: 'file' | 'files' | 'folder'
  id?: string
  ids?: string[]
  file?: LibraryFile
  files?: LibraryFile[]
  folder?: LibraryFolder
}

/** Build the JSON-serializable payload written to the drag data transfer. */
export function serializeLibraryDragItem(item: LibraryDragItem): SerializedLibraryDragItem {
  if (item.type === 'file') {
    return { type: 'file', id: item.file.id, file: item.file }
  }
  if (item.type === 'files') {
    return { type: 'files', ids: item.files.map((file) => file.id), files: item.files }
  }
  return { type: 'folder', id: item.folder.id, folder: item.folder }
}

/**
 * Parse a raw `LIBRARY_DRAG_MIME` blob into a `LibraryDragItem`, resolving ids
 * against the caller's current `files`/`folders` and falling back to the
 * inline snapshot in the blob. Returns `null` for an empty/malformed blob or
 * when the payload cannot be resolved to any known or embedded item.
 */
export function parseLibraryDragItem(
  raw: string,
  lookup: { files: readonly LibraryFile[]; folders: readonly LibraryFolder[] }
): LibraryDragItem | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as ParsedLibraryDragItem
    if (!parsed.type) return null
    if (parsed.type === 'file') {
      if (!parsed.id) return null
      const file = lookup.files.find((entry) => entry.id === parsed.id)
      return file ? { type: 'file', file } : parsed.file ? { type: 'file', file: parsed.file } : null
    }
    if (parsed.type === 'files') {
      if (!Array.isArray(parsed.ids) || parsed.ids.length === 0) return null
      const draggedFiles = lookup.files.filter((entry) => parsed.ids?.includes(entry.id))
      return draggedFiles.length > 0
        ? { type: 'files', files: draggedFiles }
        : Array.isArray(parsed.files) && parsed.files.length > 0
          ? { type: 'files', files: parsed.files }
          : null
    }
    if (!parsed.id) return null
    const folder = lookup.folders.find((entry) => entry.id === parsed.id)
    return folder ? { type: 'folder', folder } : parsed.folder ? { type: 'folder', folder: parsed.folder } : null
  } catch {
    return null
  }
}
