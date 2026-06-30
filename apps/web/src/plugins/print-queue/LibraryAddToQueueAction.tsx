/**
 * Slot component for `library.fileActions`. Adds an "Add to queue" item to the
 * library file kebab menu. Directly-printable files (.gcode / .gcode.3mf) open the
 * add dialog; an unsliced project 3MF is sliced first, then the sliced output is
 * queued. Clicking records the request in the module store; the always-mounted host
 * ({@link LibraryAddToQueueHost}) renders the flow, since the menu (and this item)
 * unmount on click.
 */
import { MenuItem } from '@mui/joy'
import PlaylistAddRounded from '@mui/icons-material/PlaylistAddRounded'
import { isDirectPrintableFileName } from '@printstream/shared'
import { requestAddToQueue, requestSliceThenQueue } from './libraryAddStore'

export function LibraryAddToQueueAction(props: Record<string, unknown>) {
  const fileId = typeof props.fileId === 'string' ? props.fileId : null
  const name = typeof props.name === 'string' ? props.name : null
  const onAction = typeof props.onAction === 'function' ? (props.onAction as () => void) : undefined

  if (!fileId || !name) return null
  const printable = isDirectPrintableFileName(name)
  // An unsliced project 3MF: a .3mf that isn't a directly-printable sliced output.
  const unslicedThreeMf = !printable && /\.3mf$/i.test(name)
  if (!printable && !unslicedThreeMf) return null

  return (
    <MenuItem
      onClick={() => {
        onAction?.()
        if (printable) requestAddToQueue({ id: fileId, name })
        else requestSliceThenQueue({ id: fileId, name })
      }}
    >
      <PlaylistAddRounded /> Add to queue
    </MenuItem>
  )
}
