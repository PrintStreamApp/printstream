/**
 * Slot button for the `library.create` extension point.
 *
 * Renders a "New 3MF" button in the library toolbar. A new project is backed
 * by a hidden, empty 3MF "scaffold" so it opens the SAME full editor (settings,
 * materials, slice) as an existing file — no file-less code path. The scaffold stays
 * out of the library (hidden); the user's real file is created when they Save, and the
 * scaffold is discarded when the editor closes.
 *
 * Self-contained so the slot renders nothing harmful when the plugin is absent (the
 * host's `<PluginSlot>` already renders nothing in that case). Mounted by the
 * `LibraryView` toolbar with `context={{ folderId, bridgeId, onRequestSlice }}`.
 */
import { useState } from 'react'
import { Button } from '@mui/joy'
import ViewInArRoundedIcon from '@mui/icons-material/ViewInArRounded'
import { apiFetch } from '../../lib/apiClient'
import { toast } from '../../lib/toast'

export function LibraryCreateAction(props: Record<string, unknown>) {
  const folderId = typeof props.folderId === 'string' ? props.folderId : null
  const bridgeId = typeof props.bridgeId === 'string' ? props.bridgeId : null
  // Host opens the full slice/editor flow on a file; `onDiscard` cleans up the scaffold.
  const onRequestSlice = typeof props.onRequestSlice === 'function'
    ? (props.onRequestSlice as (file: { id: string; name: string }, opts?: { onDiscard?: () => void }) => void)
    : undefined
  const [creating, setCreating] = useState(false)

  const handleCreate = async () => {
    if (!onRequestSlice || creating) return
    setCreating(true)
    try {
      const { file } = await apiFetch<{ file: { id: string; name: string } }>('/api/editor/new-project', {
        method: 'POST',
        body: { bridgeId, folderId }
      })
      onRequestSlice(file, {
        onDiscard: () => {
          // Best-effort: abandoning a new project should never surface an error to the user, and
          // the server sweeps un-discarded scaffolds anyway (pruneHiddenLibraryFiles). But it must
          // not be SILENT — a discard that keeps failing is invisible except as hidden scaffold
          // rows piling up, which is exactly how the leak this replaced went unnoticed.
          void apiFetch(`/api/editor/scaffold/${file.id}/discard`, { method: 'POST' }).catch((error: unknown) => {
            console.warn(`[model-studio] could not discard the abandoned project scaffold ${file.id}`, error)
          })
        }
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start a new project.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="solid"
      color="primary"
      loading={creating}
      startDecorator={<ViewInArRoundedIcon />}
      onClick={() => void handleCreate()}
    >
      New 3MF
    </Button>
  )
}
