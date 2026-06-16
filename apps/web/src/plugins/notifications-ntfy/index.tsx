/**
 * ntfy notifications plugin (web side).
 *
 * Server-side plugin owns delivery; this plugin only contributes a
 * settings panel that targets `/api/plugins/notifications-ntfy/topic`.
 */
/* eslint-disable react-refresh/only-export-components -- plugin entry exports a component intentionally */
import type { WebPlugin } from '../../plugin/types'
import { WebhookSettingsPanel } from '../../plugin/WebhookSettingsPanel'

function NtfyPanel() {
  return (
    <WebhookSettingsPanel
      pluginName="notifications-ntfy"
      endpoint="topic"
      bodyField="topicUrl"
      configuredField="topicConfigured"
      label="ntfy topic URL"
      placeholder="https://ntfy.sh/your-topic"
      helpConfigured="A notification topic is configured."
      helpEmpty="No topic configured. Paste a ntfy topic URL to receive print alerts."
    />
  )
}

export const notificationsNtfyPlugin: WebPlugin = {
  name: 'notifications-ntfy',
  version: '0.2.0',
  description: 'Forward printer notifications to a ntfy-style HTTP topic.',
  settingsPanel: NtfyPanel
}
