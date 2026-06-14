import type { AuthUserPasskey } from '@printstream/shared'

export type PasskeyVisualKind = 'synced' | 'device' | 'phone' | 'security-key' | 'generic'
export type PasskeyProviderKind = 'bitwarden' | 'google-password-manager' | null

export interface PasskeyMetadata {
  defaultLabel: string
  providerLabel: string | null
  walletLabel: string
  authenticatorLabel: string
  transportLabel: string
  visualKind: PasskeyVisualKind
  providerKind: PasskeyProviderKind
}

const KNOWN_AAGUIDS: Record<string, Pick<PasskeyMetadata, 'defaultLabel' | 'providerLabel' | 'walletLabel' | 'authenticatorLabel' | 'visualKind' | 'providerKind'>> = {
  'fa2b99dc-9e39-4257-8f92-4a30d23c4118': {
    defaultLabel: 'YubiKey 5',
    providerLabel: 'Yubico',
    walletLabel: 'Yubico hardware security key',
    authenticatorLabel: 'YubiKey 5 Series authenticator',
    visualKind: 'security-key',
    providerKind: null
  },
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': {
    defaultLabel: 'Windows Hello',
    providerLabel: 'Windows Hello',
    walletLabel: 'Windows Hello passkey wallet',
    authenticatorLabel: 'Windows device authenticator',
    visualKind: 'device',
    providerKind: null
  },
  'd548826e-79b4-db40-a3d8-11116f7e8349': {
    defaultLabel: 'Bitwarden passkey',
    providerLabel: 'Bitwarden',
    walletLabel: 'Bitwarden vault',
    authenticatorLabel: 'Bitwarden synced passkey provider',
    visualKind: 'synced',
    providerKind: 'bitwarden'
  },
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': {
    defaultLabel: 'Google Password Manager passkey',
    providerLabel: 'Google Password Manager',
    walletLabel: 'Google Password Manager',
    authenticatorLabel: 'Google Password Manager synced passkey provider',
    visualKind: 'synced',
    providerKind: 'google-password-manager'
  }
}

type PasskeyMetadataInput = Pick<AuthUserPasskey, 'aaguid' | 'backedUp'> & {
  transports?: string[] | null
}

export function describePasskey(passkey: PasskeyMetadataInput): PasskeyMetadata {
  const normalizedAaguid = passkey.aaguid?.toLowerCase() ?? null
  const known = normalizedAaguid ? KNOWN_AAGUIDS[normalizedAaguid] : undefined
  const transports = normalizePasskeyTransports(passkey.transports)
  const transportLabel = formatPasskeyTransportLabel(transports)

  if (known) {
    return {
      ...known,
      transportLabel
    }
  }

  if (passkey.backedUp) {
    return {
      defaultLabel: 'Synced passkey',
      providerLabel: null,
      walletLabel: 'Synced passkey wallet',
      authenticatorLabel: includesTransport(transports, 'internal')
        ? 'Built-in device authenticator'
        : 'Multi-device passkey provider',
      transportLabel,
      visualKind: 'synced',
      providerKind: null
    }
  }

  if (includesAnyTransport(transports, ['usb', 'nfc', 'smart-card'])) {
    return {
      defaultLabel: 'Security key',
      providerLabel: null,
      walletLabel: 'Portable hardware security key',
      authenticatorLabel: 'Cross-device hardware authenticator',
      transportLabel,
      visualKind: 'security-key',
      providerKind: null
    }
  }

  if (includesTransport(transports, 'hybrid')) {
    return {
      defaultLabel: 'Nearby phone passkey',
      providerLabel: null,
      walletLabel: 'Nearby device passkey bridge',
      authenticatorLabel: 'Hybrid passkey authenticator',
      transportLabel,
      visualKind: 'phone',
      providerKind: null
    }
  }

  if (includesTransport(transports, 'internal')) {
    return {
      defaultLabel: 'This device',
      providerLabel: null,
      walletLabel: 'On-device passkey wallet',
      authenticatorLabel: 'Built-in device authenticator',
      transportLabel,
      visualKind: 'device',
      providerKind: null
    }
  }

  return {
    defaultLabel: 'Passkey authenticator',
    providerLabel: null,
    walletLabel: 'Unknown passkey wallet',
    authenticatorLabel: 'Unknown authenticator type',
    transportLabel,
    visualKind: 'generic',
    providerKind: null
  }
}

export function suggestPasskeyNickname(passkey: PasskeyMetadataInput): string {
  return describePasskey(passkey).defaultLabel
}

export function formatPasskeyTransportLabel(transports: string[] | null | undefined): string {
  const normalizedTransports = normalizePasskeyTransports(transports)
  if (normalizedTransports.length === 0) return 'Transport not reported'

  return normalizedTransports
    .map((transport) => {
      switch (transport) {
        case 'internal':
          return 'Built-in'
        case 'hybrid':
          return 'Hybrid / QR'
        case 'smart-card':
          return 'Smart card'
        case 'usb':
          return 'USB'
        case 'nfc':
          return 'NFC'
        case 'ble':
          return 'Bluetooth'
        case 'cable':
          return 'Cable'
        default:
          return transport
      }
    })
    .join(', ')
}

function normalizePasskeyTransports(transports: string[] | null | undefined): string[] {
  return Array.isArray(transports) ? transports.filter((transport) => typeof transport === 'string') : []
}

function includesTransport(transports: string[], transport: string): boolean {
  return transports.includes(transport)
}

function includesAnyTransport(transports: string[], candidates: string[]): boolean {
  return candidates.some((candidate) => transports.includes(candidate))
}