/**
 * Bambu Cloud preset sync (web side).
 *
 * Contributes three surfaces, all through slots core renders empty when this plugin is
 * absent: the account panel in the slicing-preset manager (`slicing.presets.sync`), the
 * "something to sync" notice on the surfaces that USE presets: the 3D editor's slice
 * sidebar and the prepare-print dialog (`slicing.presets.syncStatus`), and the
 * link-your-account card on the Get started page (`quickstart.tips`).
 *
 * Counterpart: `apps/api/src/plugins/bambu-cloud-sync/index.ts`.
 */
import type { WebPlugin } from '../../plugin/types'
import { BambuCloudQuickStartTip } from './BambuCloudQuickStartTip'
import { BambuCloudSyncCard } from './BambuCloudSyncCard'
import { BambuCloudSyncStatus } from './BambuCloudSyncStatus'

export const bambuCloudSyncWebPlugin: WebPlugin = {
  name: 'bambu-cloud-sync',
  version: '1.0.0',
  description: 'Sync slicing presets with a Bambu Lab account, both ways.',
  slots: [
    { name: 'slicing.presets.sync', component: BambuCloudSyncCard },
    // Shown where presets are USED (editor sidebar, prepare-print dialog), not just where
    // they are managed, that is the point of checking without auto-syncing.
    { name: 'slicing.presets.syncStatus', component: BambuCloudSyncStatus },
    // Onboarding: linking an account is setup worth doing, but it is this plugin's capability, so
    // the Get started page hosts it through a slot rather than knowing about Bambu accounts.
    { name: 'quickstart.tips', component: BambuCloudQuickStartTip }
  ]
}
