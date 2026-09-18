/**
 * Android passkey identity shared by WebAuthn verification and Digital Asset
 * Links. One certificate list drives both representations so they cannot drift:
 * colon-hex in `assetlinks.json`, base64url in the native WebAuthn origin.
 */
import { env } from './env.js'

export const PRINTSTREAM_ANDROID_PACKAGES = ['app.printstream', 'app.printstream.test'] as const

export interface AndroidAssetLinkStatement {
  relation: ['delegate_permission/common.get_login_creds', 'delegate_permission/common.handle_all_urls']
  target: {
    namespace: 'android_app'
    package_name: string
    sha256_cert_fingerprints: string[]
  }
}

/** Normalize and validate a comma-separated list of SHA-256 fingerprints. */
export function parseAndroidCertificateFingerprints(value: string | undefined): string[] {
  if (!value?.trim()) return []

  const fingerprints = value.split(',').map((entry) => {
    const hex = entry.replace(/:/g, '').trim().toUpperCase()
    if (!/^[0-9A-F]{64}$/.test(hex)) {
      throw new Error('ANDROID_APP_CERT_FINGERPRINTS entries must be SHA-256 fingerprints.')
    }
    return hex.match(/.{2}/g)!.join(':')
  })

  return [...new Set(fingerprints)]
}

/** Convert a colon-hex certificate fingerprint to Android's WebAuthn origin. */
export function androidPasskeyOrigin(fingerprint: string): string {
  const hex = fingerprint.replace(/:/g, '')
  return `android:apk-key-hash:${Buffer.from(hex, 'hex').toString('base64url')}`
}

/** Native origins accepted alongside the deployment's browser origins. */
export function configuredAndroidPasskeyOrigins(): string[] {
  return parseAndroidCertificateFingerprints(env.ANDROID_APP_CERT_FINGERPRINTS).map(androidPasskeyOrigin)
}

/** Build the public association document for the production and test app ids. */
export function buildAndroidAssetLinks(
  fingerprints = parseAndroidCertificateFingerprints(env.ANDROID_APP_CERT_FINGERPRINTS),
  packages: readonly string[] = PRINTSTREAM_ANDROID_PACKAGES
): AndroidAssetLinkStatement[] {
  if (fingerprints.length === 0) return []

  return packages.map((packageName) => ({
    // Bitwarden's OriginManager validates handle_all_urls, even for passkeys.
    // Keep the credential relation for other providers too. This does not add
    // Android intent filters or make the wrapper intercept arbitrary links.
    relation: ['delegate_permission/common.get_login_creds', 'delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: packageName,
      sha256_cert_fingerprints: [...fingerprints]
    }
  }))
}
