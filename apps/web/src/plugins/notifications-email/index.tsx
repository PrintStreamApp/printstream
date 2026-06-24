/**
 * Email notifications plugin (web side).
 *
 * The API plugin owns delivery; this contributes the per-user opt-in panel.
 */
/* eslint-disable react-refresh/only-export-components -- plugin entry exports a component intentionally */
import type { WebPlugin } from '../../plugin/types'
import { EmailNotificationsPanel } from './EmailNotificationsPanel'

export const notificationsEmailWebPlugin: WebPlugin = {
  name: 'notifications-email',
  version: '0.1.0',
  description: 'Email workspace members about printer notifications.',
  settingsPanel: EmailNotificationsPanel
}
