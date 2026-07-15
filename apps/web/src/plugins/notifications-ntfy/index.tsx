/**
 * ntfy notifications plugin (web side).
 *
 * Pairs with the API plugin `notifications-ntfy`. Contributes a settings
 * panel managing the workspace's ntfy destinations: shared topics that
 * receive the workspace's notifications, and personal topics that receive
 * only the current user's targeted messages.
 */
/* eslint-disable react-refresh/only-export-components -- plugin entry exports a component intentionally */
import type { WebPlugin } from '../../plugin/types'
import { WebhookRecipientsPanel } from '../../plugin/WebhookRecipientsPanel'

function NtfyPanel() {
  return (
    <WebhookRecipientsPanel
      pluginName="notifications-ntfy"
      urlLabel="ntfy topic URL"
      placeholder="https://ntfy.sh/your-topic"
      description="Push notifications to ntfy topics. Add a shared topic for the workspace, or a personal one that only receives notifications addressed to you."
    />
  )
}

export const notificationsNtfyPlugin: WebPlugin = {
  name: 'notifications-ntfy',
  version: '0.3.0',
  description: 'Forward printer notifications to ntfy topics (shared and personal).',
  settingsPanel: NtfyPanel
}
