import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser'

/**
 * Tailor server-issued registration options to the current client.
 *
 * Native Windows registration is deliberately platform-only: the installed
 * app should open Windows Hello, not add another destination choice before the
 * operating system prompt. Web browsers and other desktop platforms retain
 * their normal passkey-provider choices.
 *
 * Do not send `client-device` here. WebAuthn hints are preferences and take
 * precedence over `authenticatorAttachment`; Chromium consequently delegated
 * an unrestricted request to Windows, which fell back to phones and security
 * keys after Windows Hello failed. Omitting hints preserves the strict
 * platform-only attachment.
 */
export function registrationOptionsForClient(
  options: PublicKeyCredentialCreationOptionsJSON,
  nativeWindowsDesktop: boolean
): PublicKeyCredentialCreationOptionsJSON {
  if (!nativeWindowsDesktop) {
    return options
  }

  const platformOptions = { ...options }
  delete platformOptions.hints

  return {
    ...platformOptions,
    authenticatorSelection: {
      ...options.authenticatorSelection,
      authenticatorAttachment: 'platform'
    }
  }
}
