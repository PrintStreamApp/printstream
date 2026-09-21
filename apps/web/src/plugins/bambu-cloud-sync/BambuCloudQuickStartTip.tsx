/**
 * The Get started page's "link your Bambu account" card.
 *
 * Lives in the plugin, not in the core checklist, because the capability does: core has no way to
 * link an account and must not learn one (`quickstart.tips` renders nothing when this plugin is
 * off). It reuses core's `QuickStartCard` so it cannot drift from the cards above it.
 *
 * Deliberately NOT part of the "N of M" checklist. That count drives whether the workspace reads as
 * set up, and a printer farm with no Bambu account is perfectly set up: presenting this as an
 * outstanding task would make a complete workspace look unfinished forever. It sits with the other
 * optional "Good to know" cards instead, and simply reports itself done once linked.
 *
 * Counterpart: `BambuCloudSyncCard`, the full panel this points at.
 */
import { useQuery } from '@tanstack/react-query'
import CloudSyncRoundedIcon from '@mui/icons-material/CloudSyncRounded'
import { QuickStartCard } from '../../components/QuickStartCard'
import { apiFetch } from '../../lib/apiClient'
import { BAMBU_CLOUD_ACCOUNT_SETTINGS_PATH } from './settings-route'

/** Only what this card needs; the real response carries the rest of the sync state. */
interface QuickStartStatusResponse {
  connection: { status: 'connected' | 'expired' } | null
}

export function BambuCloudQuickStartTip({
  workspacePath,
  canOpenSettings
}: {
  workspacePath?: (path: string) => string
  canOpenSettings?: boolean
}): JSX.Element | null {
  // Same key the sync card uses, so linking an account there updates this card without a refetch.
  const statusQuery = useQuery({
    queryKey: ['bambu-cloud-sync', 'status'],
    queryFn: ({ signal }) => apiFetch<QuickStartStatusResponse>('/api/plugins/bambu-cloud-sync/status', { signal })
  })

  // The status route is settings-manage gated, so a viewer without that permission gets a 403 and
  // no answer about linkage. Showing them a card they can neither judge nor act on is worse than
  // showing nothing, and the same permission already de-links the other settings cards here.
  if (!canOpenSettings || !workspacePath || statusQuery.isError) return null

  const connection = statusQuery.data?.connection ?? null
  const expired = connection?.status === 'expired'
  const linked = connection != null && !expired

  return (
    <QuickStartCard
      icon={<CloudSyncRoundedIcon />}
      title={linked ? 'Bambu account linked' : expired ? 'Reconnect your Bambu account' : 'Link your Bambu account'}
      description={linked
        ? 'This workspace can import from MakerWorld with your Bambu Lab account and sync the slicing presets you tuned in Bambu Studio.'
        : expired
          ? 'The link to your Bambu Lab account has expired, so MakerWorld imports and preset sync are unavailable. Reconnect it in Bambu account settings.'
          : 'Link a Bambu Lab account to import models from MakerWorld and sync your slicing presets both ways.'}
      // A linked account still links through: unlike a setup step there is nothing to "complete",
      // and the panel is where you sync, review held presets, or disconnect.
      actionTo={workspacePath(BAMBU_CLOUD_ACCOUNT_SETTINGS_PATH)}
    />
  )
}
