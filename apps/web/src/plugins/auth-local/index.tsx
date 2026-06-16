/**
 * Web companion for the local-auth provider.
 *
 * Contributes the passkey/email-code sign-in UI and first-run local-auth setup
 * card to the core auth and settings shells.
 */
import type { WebPlugin } from '../../plugin/types'
import { AuthLocalAccountSecuritySection } from './AuthLocalAccountSecuritySection'
import { AuthLocalProviderSettingsSection } from './AuthLocalProviderSettingsSection'
import { AuthLocalRecentVerificationSection } from './AuthLocalRecentVerificationSection'
import { AuthLocalSignInSection } from './AuthLocalSignInSection'
import { AuthLocalSetupSection } from './AuthLocalSetupSection'
import { AuthLocalUserCredentialsSection } from './AuthLocalUserCredentialsSection'
import { AuthLocalUserLifecycleSection } from './AuthLocalUserLifecycleSection'

export const authLocalWebPlugin: WebPlugin = {
  name: 'auth-local',
  version: '0.1.0',
  description: 'Passkey and one-time email-code authentication for local operators.',
  slots: [
    {
      name: 'auth.signIn',
      component: AuthLocalSignInSection
    },
    {
      name: 'settings.authenticationSetup',
      component: AuthLocalSetupSection
    },
    {
      name: 'settings.authenticationProviders',
      component: AuthLocalProviderSettingsSection
    },
    {
      name: 'account.security',
      component: AuthLocalAccountSecuritySection
    },
    {
      name: 'auth.recentVerification',
      component: AuthLocalRecentVerificationSection
    },
    {
      name: 'auth.userManagement.lifecycle',
      component: AuthLocalUserLifecycleSection
    },
    {
      name: 'auth.userManagement.credentials',
      component: AuthLocalUserCredentialsSection
    }
  ]
}