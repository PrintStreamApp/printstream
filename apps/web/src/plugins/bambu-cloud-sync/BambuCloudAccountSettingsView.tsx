/** Dedicated Settings destination for the workspace's Bambu Cloud connection. */
import { Alert, Stack } from '@mui/joy'
import { useLocation, useNavigate } from 'react-router-dom'
import { pageSectionStackSpacing } from '../../components/dashboard/PageSectionHeading'
import { NestedViewHeader } from '../../components/NestedViewHeader'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { buildWorkspacePath, parseWorkspacePathname } from '../../lib/workspaceRoute'
import { BambuCloudSyncCard } from './BambuCloudSyncCard'

export function BambuCloudAccountSettingsView(): JSX.Element {
  const location = useLocation()
  const navigate = useNavigate()
  const authBootstrapQuery = useAuthBootstrapQuery()
  const workspaceSlug = parseWorkspacePathname(location.pathname).workspaceSlug
  const settingsPath = workspaceSlug ? buildWorkspacePath(workspaceSlug, '/settings') : '/settings'

  if (!authBootstrapQuery.data?.capabilities.canManageSettings) {
    return <Alert color="warning" variant="soft">Settings access required.</Alert>
  }

  return (
    <Stack spacing={pageSectionStackSpacing}>
      <NestedViewHeader
        crumbs={[
          { label: 'Settings', onClick: () => navigate(settingsPath) },
          { label: 'Bambu account' }
        ]}
        description="Manage the Bambu Lab account used for pasted MakerWorld links and slicing preset sync in this workspace. App browsing uses a separate website sign-in."
      />
      <BambuCloudSyncCard />
    </Stack>
  )
}
