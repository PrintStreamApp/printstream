/**
 * SMTP transport plugin (web side, self-hosted only).
 *
 * The API plugin owns the transport + persistence; this only contributes the
 * server settings panel. In the cloud build the API does not register the
 * `email-smtp` plugin, so this panel never appears in the plugin manager.
 */
import type { WebPlugin } from '../../plugin/types'
import { SmtpSettingsPanel } from './SmtpSettingsPanel'

export const emailSmtpWebPlugin: WebPlugin = {
  name: 'email-smtp',
  version: '0.1.0',
  description: 'Send email through your own SMTP server (self-hosted).',
  settingsPanel: SmtpSettingsPanel
}
