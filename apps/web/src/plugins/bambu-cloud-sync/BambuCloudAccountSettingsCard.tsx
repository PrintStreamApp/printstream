/** Settings-overview entry for the enabled Bambu Cloud Sync plugin. */
import { useLocation, useNavigate } from 'react-router-dom'
import { SettingsOverviewCard } from '../../components/settings/SettingsOverviewCard'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { buildWorkspacePath, parseWorkspacePathname } from '../../lib/workspaceRoute'
import { BAMBU_CLOUD_ACCOUNT_SETTINGS_PATH } from './settings-route'

export function BambuCloudAccountSettingsCard(): JSX.Element | null {
  const location = useLocation()
  const navigate = useNavigate()
  const authBootstrapQuery = useAuthBootstrapQuery()
  const workspaceSlug = parseWorkspacePathname(location.pathname).workspaceSlug

  // The plugin APIs are settings-manage gated. Do not advertise a destination
  // that can only answer with an access error for workspace viewers.
  if (!workspaceSlug || !authBootstrapQuery.data?.capabilities.canManageSettings) return null

  return (
    <SettingsOverviewCard
      title="Bambu account"
      description="Connect, reconnect, or disconnect the Bambu Lab account used for pasted MakerWorld links and slicing preset sync. App browsing uses a separate website sign-in."
      onAction={() => navigate(buildWorkspacePath(workspaceSlug, BAMBU_CLOUD_ACCOUNT_SETTINGS_PATH))}
    />
  )
}
