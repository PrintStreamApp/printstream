/**
 * Discord notifications plugin (web side).
 *
 * Pairs with the API plugin `notifications-discord`. Contributes a settings
 * panel managing the workspace's Discord destinations: shared webhooks that
 * receive the workspace's notifications, and personal webhooks that receive
 * only the current user's targeted messages.
 */
/* eslint-disable react-refresh/only-export-components -- plugin entry exports a component intentionally */
import type { WebPlugin } from '../../plugin/types'
import { WebhookRecipientsPanel } from '../../plugin/WebhookRecipientsPanel'

function DiscordPanel() {
  return (
    <WebhookRecipientsPanel
      pluginName="notifications-discord"
      urlLabel="Discord webhook URL"
      placeholder="https://discord.com/api/webhooks/…"
      description="Post notifications to Discord. Add a shared webhook for a team channel, or a personal one that only receives notifications addressed to you."
    />
  )
}

export const notificationsDiscordPlugin: WebPlugin = {
  name: 'notifications-discord',
  version: '0.2.0',
  description: 'Forward printer notifications to Discord webhooks (shared channels and personal ones).',
  settingsPanel: DiscordPanel
}
