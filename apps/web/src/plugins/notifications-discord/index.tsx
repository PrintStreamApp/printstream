/**
 * Discord notifications plugin (web side).
 *
 * Pairs with the API plugin `notifications-discord`. Contributes a
 * settings panel where users paste their Discord webhook URL.
 */
/* eslint-disable react-refresh/only-export-components -- plugin entry exports a component intentionally */
import type { WebPlugin } from '../../plugin/types'
import { WebhookSettingsPanel } from '../../plugin/WebhookSettingsPanel'

function DiscordPanel() {
  return (
    <WebhookSettingsPanel
      pluginName="notifications-discord"
      endpoint="webhook"
      bodyField="webhookUrl"
      configuredField="webhookConfigured"
      label="Discord webhook URL"
      placeholder="https://discord.com/api/webhooks/…"
      helpConfigured="A Discord webhook is configured."
      helpEmpty="No webhook configured. Paste a Discord webhook URL to receive print alerts in a channel."
    />
  )
}

export const notificationsDiscordPlugin: WebPlugin = {
  name: 'notifications-discord',
  version: '0.1.0',
  description: 'Forward printer notifications to a Discord webhook.',
  settingsPanel: DiscordPanel
}
