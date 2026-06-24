/**
 * Web companion for the password (`auth-password`) provider.
 *
 * Contributes the email/password sign-in UI, first-run setup card, provider
 * toggle, self-service change-password panel, password re-verification, and
 * admin set/reset controls. Each section renders `null` when the provider is
 * absent from the auth bootstrap, so this plugin stays inert in the cloud build
 * (where `auth-local` is active instead).
 */
import type { WebPlugin } from '../../plugin/types'
import { AuthPasswordAccountSecuritySection } from './AuthPasswordAccountSecuritySection'
import { AuthPasswordProviderSettingsSection } from './AuthPasswordProviderSettingsSection'
import { AuthPasswordRecentVerificationSection } from './AuthPasswordRecentVerificationSection'
import { AuthPasswordSetupSection } from './AuthPasswordSetupSection'
import { AuthPasswordSignInSection } from './AuthPasswordSignInSection'
import { AuthPasswordUserCredentialsSection } from './AuthPasswordUserCredentialsSection'

export const authPasswordWebPlugin: WebPlugin = {
  name: 'auth-password',
  version: '0.1.0',
  description: 'Email and password authentication for self-hosted operators.',
  slots: [
    {
      name: 'auth.signIn',
      component: AuthPasswordSignInSection
    },
    {
      name: 'settings.authenticationSetup',
      component: AuthPasswordSetupSection
    },
    {
      name: 'settings.authenticationProviders',
      component: AuthPasswordProviderSettingsSection
    },
    {
      name: 'account.security',
      component: AuthPasswordAccountSecuritySection
    },
    {
      name: 'auth.recentVerification',
      component: AuthPasswordRecentVerificationSection
    },
    {
      name: 'auth.userManagement.credentials',
      component: AuthPasswordUserCredentialsSection
    }
  ]
}
