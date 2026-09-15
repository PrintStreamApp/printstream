/**
 * Self-hosted PrintStream Cloud connection. Contributes licensed support
 * conversations; all requests go through the local relay. It deliberately has
 * no background unread poll because an enabled plugin must stay network-silent
 * until someone opens a support surface.
 */
import type { WebPlugin } from '../../plugin/types'
import { CloudConnectionSettingsPanel } from './CloudConnectionSettingsPanel'
import {
  SelfHostedAccountMessagesSection,
  SelfHostedHelpDialogConversations
} from './SupportSlots'
import { SelfHostedSuggestionsFooterLink, SelfHostedSuggestionsView } from './SuggestionSlots'

export const cloudConnectionWebPlugin: WebPlugin = {
  name: 'cloud-connection',
  version: '0.1.0',
  description: 'Licensed in-app support and product suggestions from PrintStream Cloud. Enabled by default; data is sent only when you use either surface.',
  selfHostedOnly: true,
  settingsPanel: CloudConnectionSettingsPanel,
  routes: [
    { path: '/suggestions/*', element: SelfHostedSuggestionsView }
  ],
  slots: [
    {
      name: 'account.support',
      component: SelfHostedAccountMessagesSection
    },
    {
      name: 'help.conversations',
      component: SelfHostedHelpDialogConversations
    },
    {
      name: 'shell.footer',
      component: SelfHostedSuggestionsFooterLink
    }
  ]
}
