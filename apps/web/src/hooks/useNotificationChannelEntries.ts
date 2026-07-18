/**
 * The notification channel entries renderable in the current workspace context
 * (tenant or platform): installed + enabled `notifications-*` plugins with a
 * settings panel. Rendered by `NotificationChannelsPanel`; also consumed by hosts
 * that need the channel count before deciding to show a Notifications section at
 * all (e.g. `PlatformView`). Own file so the panel exports only components
 * (react-refresh).
 */
import { usePluginCatalogQuery } from '../lib/pluginCatalogQuery'
import {
  compareNotificationPluginEntries,
  isNotificationPlugin,
  mergePlugins,
  shouldRenderPluginSettingsPanel,
  type MergedPluginEntry
} from '../lib/pluginSettings'
import { webPluginRegistry } from '../plugin/registry'

export function useNotificationChannelEntries() {
  const pluginCatalogQuery = usePluginCatalogQuery({ suppressGlobalErrorToast: true })
  // A channel's web panel talks to its API plugin, so the plugin must exist
  // in the CURRENT surface's catalog. Web-only merged entries default to
  // installed/enabled/available, which would mount the other surface's
  // panels here (tenant channels on the platform view and vice versa) and
  // toast "Plugin unavailable in this workspace" from their status queries.
  const present = mergePlugins(pluginCatalogQuery.data?.plugins ?? [], webPluginRegistry.list())
    .filter((entry): entry is MergedPluginEntry => isNotificationPlugin(entry.name))
    .filter((entry) => entry.api != null)
  // Channels that exist in this context, enabled or not — hosts use this to
  // decide whether a Notifications section exists at all (the panel's own
  // "enable a plugin" empty state covers the none-enabled case).
  const availableChannels = present.filter((entry) =>
    Boolean(entry.api?.installed && entry.api.availableInCurrentContext))
  const channels = present
    .filter((entry) => shouldRenderPluginSettingsPanel(entry, 'notifications'))
    .sort(compareNotificationPluginEntries)
  return { pluginCatalogQuery, channels, availableChannels }
}
