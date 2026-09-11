import { ListItemDecorator, MenuItem } from '@mui/joy'
import ViewInArRoundedIcon from '@mui/icons-material/ViewInArRounded'
import { isMeshLibraryFileKind } from '@printstream/shared'

/**
 * Slot component for `library.fileActions`. The library page renders it
 * inside the file kebab menu so the previewer can add a dedicated menu item.
 */
export function LibraryPreviewAction(props: Record<string, unknown>) {
  const fileId = typeof props.fileId === 'string' ? props.fileId : null
  const kind = typeof props.kind === 'string' ? props.kind : null
  const onAction = typeof props.onAction === 'function' ? props.onAction as (() => void) : undefined
  const onPreview = typeof props.onPreview === 'function' ? props.onPreview as (() => void) : undefined

  // Everything the previewer can render: any bare mesh, a 3MF (plated or geometry-only), and a
  // sliced gcode's toolpaths. `kind` arrives as a bare string through the plugin slot's untyped
  // props, which is exactly the shape `isMeshLibraryFileKind` takes.
  if (!fileId || !onPreview) return null
  if (kind == null || !(isMeshLibraryFileKind(kind) || kind === '3mf' || kind === 'gcode')) return null

  const label = 'Preview'

  return (
    <MenuItem
      onClick={() => {
        onAction?.()
        onPreview()
      }}
    >
      <ListItemDecorator><ViewInArRoundedIcon /></ListItemDecorator>
      {label}
    </MenuItem>
  )
}
