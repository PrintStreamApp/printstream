/**
 * Web companion for the OAuth provider.
 *
 * Contributes the external-provider sign-in entry point and the setup form
 * used in both the auth settings section and the plugin manager.
 */
import type { WebPlugin } from '../../plugin/types'
import { AuthOAuthProviderSettingsSection, AuthOAuthSettingsPanel, AuthOAuthSetupSection } from './AuthOAuthSettingsPanel'
import { AuthOAuthSignInSection } from './AuthOAuthSignInSection'

export const authOauthWebPlugin: WebPlugin = {
  name: 'auth-oauth',
  version: '0.1.0',
  description: 'Generic OpenID Connect sign-in for external identity providers.',
  slots: [
    {
      name: 'auth.signIn',
      component: AuthOAuthSignInSection,
      order: 20
    },
    {
      name: 'settings.authenticationSetup',
      component: AuthOAuthSetupSection,
      order: 20
    },
    {
      name: 'settings.authenticationProviders',
      component: AuthOAuthProviderSettingsSection,
      order: 20
    }
  ],
  settingsPanel: AuthOAuthSettingsPanel
}