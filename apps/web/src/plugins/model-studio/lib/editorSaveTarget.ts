/**
 * Where a saved project goes.
 *
 * The editor produces a `SceneEdit`; what happens next differs entirely by host. The library host
 * POSTs it and the server bakes and persists a `LibraryFile` version. A host with only a local file
 * bakes in the tab and writes bytes back to the user's disk — nothing is persisted anywhere, and
 * there is no library to invalidate or slice controller to notify.
 *
 * That last part is why {@link EditorSaveTarget.isLibraryBacked} exists rather than the hook
 * sniffing for a controller: the post-save choreography around a library save is order-sensitive
 * (see `useEditorSave`) and must be skipped wholesale, not partially, when there is no library.
 */
import type { ExportArrangedThreeMf, SaveArrangedThreeMf } from '@printstream/shared'
import { apiFetch } from '../../../lib/apiClient'
import { buildApiUrl } from '../../../lib/apiUrl'
import { readWorkspaceContextHeader } from '../../../lib/workspaceContext'
import { fetchModelBytes } from './modelFetch'

/** What a completed save reports back. */
export interface EditorSavedFile {
  id: string
  name: string
  /**
   * The version row this save archived — the content that was current until now, i.e. the bytes
   * this save authored FROM. The caller pins it so the NEXT save authors from the same original
   * rather than from this save's output (see `contentBase` in the shared save schema).
   *
   * Null when nothing was archived (a save that created a new file, or a target with no version
   * history at all), which the caller reads as "keep the pin you already have".
   */
  archivedVersionId?: string | null
}

export interface EditorSaveTarget {
  /**
   * Persist an edited project.
   *
   * @returns the saved file's identity, or null when the save did not happen for a reason the user
   *   already knows about (they dismissed a destination picker). A FAILURE throws instead, so the
   *   caller can surface it — a silent null would look like a successful save that saved nothing.
   */
  persist(payload: SaveArrangedThreeMf): Promise<EditorSavedFile | null>
  /** Bake without persisting, for the "download a copy" paths. */
  exportBytes(payload: ExportArrangedThreeMf): Promise<Uint8Array>
  /**
   * True when a save lands in the library, so the caller should invalidate library queries and tell
   * the slice controller to rebase its material overlay. False for a local file.
   */
  readonly isLibraryBacked: boolean
}

/** The library-backed target: the server bakes and persists, as it always has. */
export const apiSaveTarget: EditorSaveTarget = {
  isLibraryBacked: true,

  async persist(payload) {
    const { file, archivedVersionId } = await apiFetch<{
      file: { id: string; name: string }
      archivedVersionId?: string | null
    }>('/api/editor/save', {
      method: 'POST',
      body: payload
    })
    return { ...file, archivedVersionId: archivedVersionId ?? null }
  },

  async exportBytes(payload) {
    const workspaceContext = readWorkspaceContextHeader()
    // Stall-guarded (see `modelFetch`): a baked 3MF is large enough that a wedged transport would
    // otherwise hang the export with no error.
    return fetchModelBytes(buildApiUrl('/api/editor/export-3mf'), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(workspaceContext ? { 'X-PrintStream-Workspace': workspaceContext } : {})
      },
      body: JSON.stringify(payload)
    })
  }
}

export function createApiSaveTarget(): EditorSaveTarget {
  return apiSaveTarget
}
