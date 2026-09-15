/**
 * App-shell footer entry point for the suggestion board (`shell.footer` slot):
 * navigates to the active workspace's `/suggestions` route. Renders
 * null in the platform workspace (the board has its own Suggestions nav tab
 * there) and outside any workspace context.
 */
import { Button } from '@mui/joy'
import EmojiObjectsOutlinedIcon from '@mui/icons-material/EmojiObjectsOutlined'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { buildWorkspacePath, parseWorkspacePathname } from '../../lib/workspaceRoute'

export function SuggestionsFooterLink() {
  const navigate = useNavigate()
  const location = useLocation()
  const authBootstrapQuery = useAuthBootstrapQuery()
  const inPlatformWorkspace = location.pathname === '/platform' || location.pathname.startsWith('/platform/')
  const workspaceSlug = parseWorkspacePathname(location.pathname).workspaceSlug
    ?? authBootstrapQuery.data?.workspace?.slug
    ?? null
  // The platform workspace has a Suggestions nav tab; the footer link would duplicate it.
  const target = !inPlatformWorkspace && workspaceSlug
    ? buildWorkspacePath(workspaceSlug, '/suggestions')
    : null
  if (!target) return null

  return (
    <Button
      variant="plain"
      color="neutral"
      size="sm"
      startDecorator={<EmojiObjectsOutlinedIcon fontSize="small" />}
      onClick={() => navigate(target)}
    >
      Suggestions
    </Button>
  )
}
