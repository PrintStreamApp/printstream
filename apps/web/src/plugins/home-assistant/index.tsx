/**
 * Home Assistant plugin (web side).
 *
 * Contributes a settings panel in the Plugin Manager section that shows
 * bridge status and install instructions. No dedicated route or tab bar
 * entry is registered — all guidance lives inline in Settings > Plugins.
 * Eager-loaded with the app shell (a light settings panel, no heavy deps).
 */
import type { WebPlugin } from '../../plugin/types'
import { HomeAssistantSettingsPanel } from './HomeAssistantSettingsPanel'

export const homeAssistantWebPlugin: WebPlugin = {
  name: 'home-assistant',
  version: '0.1.0',
  description: 'Bridge printers and AMS units into Home Assistant, including bundled Lovelace cards.',
  settingsPanel: HomeAssistantSettingsPanel
}
