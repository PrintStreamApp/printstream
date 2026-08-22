/**
 * Menu entries for the `library.upload.menu` and `printers.print.menu` slots.
 *
 * They NAVIGATE to the import view rather than opening a dialog, and that is a
 * constraint, not a style choice: a slot component rendered inside a Joy `Menu` is
 * unmounted the moment the menu closes — which is the same click that would open the
 * dialog — so a dialog owned here mounts and dies in the same tick and the item looks
 * dead. Anything a menu item triggers has to be owned by something that outlives the
 * menu; a route is the simplest thing that qualifies.
 *
 * Navigating also keeps ONE import surface. The view already asks for the URL,
 * resolves MakerWorld through the connected Bambu account, picks a bridge, and offers
 * "Import and print" — a dialog here would have been a second, thinner copy of it.
 */
import { ListItemDecorator, MenuItem } from '@mui/joy'
import CloudDownloadRoundedIcon from '@mui/icons-material/CloudDownloadRounded'
import { Link as RouterLink, useParams } from 'react-router-dom'
import { buildWorkspacePath } from '../../lib/workspaceRoute'

function useImportPath(search = ''): string {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()
  const path = `/library/import${search}`
  return workspaceSlug ? buildWorkspacePath(workspaceSlug, path) : path
}

/** Library Upload menu: bring a file in from a URL. */
export function LibraryImportMenuAction(props: Record<string, unknown>) {
  const bridgeId = typeof props.bridgeId === 'string' ? props.bridgeId : null
  // Carry the toolbar's current bridge so the view opens pointed where the user was.
  const to = useImportPath(bridgeId ? `?bridgeId=${encodeURIComponent(bridgeId)}` : '')

  return (
    <MenuItem component={RouterLink} to={to}>
      <ListItemDecorator><CloudDownloadRoundedIcon /></ListItemDecorator>
      Import from URL…
    </MenuItem>
  )
}

/**
 * Printers Print menu: same destination, different framing.
 *
 * `print=1` asks the view to lead with "Import and print" rather than a plain import,
 * since the user started from a Print control and expects to end at a printer.
 */
export function PrinterImportMenuAction() {
  const to = useImportPath('?print=1')

  return (
    <MenuItem component={RouterLink} to={to}>
      <ListItemDecorator><CloudDownloadRoundedIcon /></ListItemDecorator>
      Print from URL…
    </MenuItem>
  )
}
