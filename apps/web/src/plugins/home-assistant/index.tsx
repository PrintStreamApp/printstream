/* eslint-disable react-refresh/only-export-components -- plugin entry exports both a lazy wrapper component and the plugin object */
/**
 * Home Assistant plugin (web side).
 *
 * Contributes a settings panel in the Plugin Manager section that shows
 * bridge status and install instructions. No dedicated route or tab bar
 * entry is registered — all guidance lives inline in Settings > Plugins.
 */
import { Suspense, lazy } from 'react'
import type { WebPlugin } from '../../plugin/types'

const HomeAssistantSettingsPanel = lazy(async () => {
  const module = await import('./HomeAssistantSettingsPanel')
  return { default: module.HomeAssistantSettingsPanel }
})

function HomeAssistantSettingsPanelSuspended() {
  return (
    <Suspense fallback={null}>
      <HomeAssistantSettingsPanel />
    </Suspense>
  )
}

export const homeAssistantWebPlugin: WebPlugin = {
  name: 'home-assistant',
  version: '0.1.0',
  description: 'Bridge printers and AMS units into Home Assistant, including bundled Lovelace cards.',
  settingsPanel: HomeAssistantSettingsPanelSuspended
}
