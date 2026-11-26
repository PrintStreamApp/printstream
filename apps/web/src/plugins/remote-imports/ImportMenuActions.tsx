/** Menu launchers delegate long-lived UI to the persistent library overlay host. */
import { ListItemDecorator, MenuItem } from '@mui/joy'
import CloudDownloadRoundedIcon from '@mui/icons-material/CloudDownloadRounded'
import { Link as RouterLink, useParams } from 'react-router-dom'
import { openLibraryImport } from './importLaunchStore'
import { buildWorkspacePath } from '../../lib/workspaceRoute'

function useImportPath(search = ''): string {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()
  const path = `/library/import${search}`
  return workspaceSlug ? buildWorkspacePath(workspaceSlug, path) : path
}

/** Library Upload menu: bring a file in from a model site or direct URL. */
export function LibraryImportMenuAction(props: Record<string, unknown>) {
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>()
  const bridgeId = typeof props.bridgeId === 'string' ? props.bridgeId : null
  const folderId = typeof props.folderId === 'string' ? props.folderId : null
  return (
    <>
      {(['makerworld', 'printables', 'url'] as const).map((source) => (
        <MenuItem key={source} onClick={() => openLibraryImport({ source, bridgeId, folderId, workspaceSlug })}>
          <ListItemDecorator><CloudDownloadRoundedIcon /></ListItemDecorator>
          {source === 'makerworld' ? 'MakerWorld' : source === 'printables' ? 'Printables' : 'From URL'}
        </MenuItem>
      ))}
    </>
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
      Print from web…
    </MenuItem>
  )
}
