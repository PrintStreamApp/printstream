/** App-navigation menu entry point for the workspace suggestion board. */
import EmojiObjectsOutlinedIcon from '@mui/icons-material/EmojiObjectsOutlined'
import React from 'react'
import { ListItemDecorator, MenuItem } from '@mui/joy'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { buildWorkspacePath, parseWorkspacePathname } from '../../lib/workspaceRoute'

export function SuggestionsMenuItem() {
  const navigate = useNavigate()
  const location = useLocation()
  const authBootstrapQuery = useAuthBootstrapQuery()
  const inPlatformWorkspace = location.pathname === '/platform' || location.pathname.startsWith('/platform/')
  const workspaceSlug = parseWorkspacePathname(location.pathname).workspaceSlug
    ?? authBootstrapQuery.data?.workspace?.slug
    ?? null
  // The platform workspace has a Suggestions nav tab; this menu entry would duplicate it.
  const target = !inPlatformWorkspace && workspaceSlug
    ? buildWorkspacePath(workspaceSlug, '/suggestions')
    : null
  if (!target) return null

  return (
    <MenuItem onClick={() => navigate(target)}>
      <ListItemDecorator><EmojiObjectsOutlinedIcon fontSize="small" /></ListItemDecorator>
      Suggestions
    </MenuItem>
  )
}
