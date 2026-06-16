import { MenuItem } from '@mui/joy'
import ViewInArRoundedIcon from '@mui/icons-material/ViewInArRounded'

/**
 * Slot component for `library.fileActions`. The library page renders it
 * inside the file kebab menu so the previewer can add a dedicated menu item.
 */
export function LibraryPreviewAction(props: Record<string, unknown>) {
  const fileId = typeof props.fileId === 'string' ? props.fileId : null
  const kind = typeof props.kind === 'string' ? props.kind : null
  const onAction = typeof props.onAction === 'function' ? props.onAction as (() => void) : undefined
  const onPreview = typeof props.onPreview === 'function' ? props.onPreview as (() => void) : undefined

  if (!fileId || !onPreview || (kind !== 'stl' && kind !== 'step' && kind !== '3mf' && kind !== 'gcode')) return null

  const label = 'Preview'

  return (
    <MenuItem
      onClick={() => {
        onAction?.()
        onPreview()
      }}
    >
      <ViewInArRoundedIcon /> {label}
    </MenuItem>
  )
}
