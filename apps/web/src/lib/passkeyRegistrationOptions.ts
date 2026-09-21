import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser'

export type PasskeyRegistrationTarget = 'local-device' | 'another-device'

/**
 * Tailor server-issued registration options to the destination the user chose.
 * A local-device registration must request a platform authenticator so Chromium
 * opens Windows Hello (or the equivalent OS prompt) instead of preferring its
 * cross-device phone flow. The unmodified options preserve every authenticator
 * choice when the user explicitly selects another device.
 */
export function registrationOptionsForTarget(
  options: PublicKeyCredentialCreationOptionsJSON,
  target: PasskeyRegistrationTarget
): PublicKeyCredentialCreationOptionsJSON {
  if (target === 'another-device') {
    return options
  }

  return {
    ...options,
    hints: ['client-device'],
    authenticatorSelection: {
      ...options.authenticatorSelection,
      authenticatorAttachment: 'platform'
    }
  }
}
