/**
 * Best-effort detection of which standalone bridge package matches the
 * visitor's machine. Resolution is pure (`resolveBridgePlatformKey`) so it is
 * unit-testable; `detectBridgePlatformKey` gathers the browser hints,
 * including Chromium's high-entropy UA-Client-Hints architecture when
 * available. A null result simply means the UI lists all packages without a
 * recommendation (phones, tablets, unknown platforms).
 */
import type { BridgeStandaloneDownload } from '@printstream/shared'

export interface BridgePlatformHints {
  userAgent?: string
  uaDataPlatform?: string
  /** UA-CH high-entropy values: 'arm' | 'x86'. */
  uaDataArchitecture?: string
  /** UA-CH high-entropy values: '64' | '32'. */
  uaDataBitness?: string
}

export const BRIDGE_PLATFORM_LABELS: Record<string, string> = {
  'win32-x64': 'Windows (x64)',
  'win32-arm64': 'Windows (ARM64)',
  'darwin-arm64': 'macOS (Apple Silicon)',
  'darwin-x64': 'macOS (Intel)',
  'linux-x64': 'Linux (x64)',
  'linux-arm64': 'Linux (ARM64)'
}

export function bridgePlatformLabel(platformKey: string): string {
  return BRIDGE_PLATFORM_LABELS[platformKey] ?? platformKey
}

type BridgePlatformOs = 'win32' | 'darwin' | 'linux' | 'other'

const BRIDGE_OS_LABELS: Record<BridgePlatformOs, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
  other: 'Other'
}

const BRIDGE_OS_ORDER: Record<BridgePlatformOs, number> = { win32: 0, darwin: 1, linux: 2, other: 3 }

export function bridgePlatformOs(platformKey: string): BridgePlatformOs {
  const os = platformKey.split('-')[0]
  return os === 'win32' || os === 'darwin' || os === 'linux' ? os : 'other'
}

/** Just the architecture portion of the label, e.g. "x64", "Apple Silicon". */
export function bridgePlatformArchLabel(platformKey: string): string {
  const match = /\(([^)]+)\)/.exec(bridgePlatformLabel(platformKey))
  return match ? match[1]! : bridgePlatformLabel(platformKey)
}

/** Stable order: OS (Windows → macOS → Linux), then x64 before ARM64. */
export function compareBridgePlatforms(a: string, b: string): number {
  const osDiff = BRIDGE_OS_ORDER[bridgePlatformOs(a)] - BRIDGE_OS_ORDER[bridgePlatformOs(b)]
  if (osDiff !== 0) return osDiff
  const archDiff = (a.endsWith('arm64') ? 1 : 0) - (b.endsWith('arm64') ? 1 : 0)
  if (archDiff !== 0) return archDiff
  return a.localeCompare(b)
}

export interface BridgePlatformGroup<T> {
  os: BridgePlatformOs
  osLabel: string
  items: T[]
}

/**
 * Sorts packages into ordered OS groups for a tidy download list. `keyOf`
 * extracts the platform key from each item.
 */
export function groupByBridgeOs<T>(items: readonly T[], keyOf: (item: T) => string): Array<BridgePlatformGroup<T>> {
  const sorted = [...items].sort((a, b) => compareBridgePlatforms(keyOf(a), keyOf(b)))
  const groups: Array<BridgePlatformGroup<T>> = []
  for (const item of sorted) {
    const os = bridgePlatformOs(keyOf(item))
    let group = groups.find((candidate) => candidate.os === os)
    if (!group) {
      group = { os, osLabel: BRIDGE_OS_LABELS[os], items: [] }
      groups.push(group)
    }
    group.items.push(item)
  }
  return groups
}

export function resolveBridgePlatformKey(hints: BridgePlatformHints): string | null {
  const userAgent = hints.userAgent ?? ''
  const os = resolveOs(hints.uaDataPlatform, userAgent)
  if (!os) return null

  const archHint = resolveUaDataArch(hints.uaDataArchitecture, hints.uaDataBitness)
  if (os === 'win32') {
    // Windows ARM browsers report an x64 user agent; only the UA-CH
    // high-entropy architecture hint distinguishes them. Without it the x64
    // package is the safe default (it runs everywhere via emulation).
    return archHint === 'arm64' ? 'win32-arm64' : 'win32-x64'
  }
  if (os === 'darwin') {
    // Safari exposes no architecture hints; Apple Silicon is the safe default
    // for current Macs, and Intel users can pick from the full list.
    return `darwin-${archHint ?? 'arm64'}`
  }
  if (archHint) return `linux-${archHint}`
  return /\b(aarch64|arm64)\b/i.test(userAgent) ? 'linux-arm64' : 'linux-x64'
}

function resolveOs(uaDataPlatform: string | undefined, userAgent: string): 'win32' | 'darwin' | 'linux' | null {
  const platform = uaDataPlatform?.toLowerCase() ?? ''
  if (platform === 'windows') return 'win32'
  if (platform === 'macos') return 'darwin'
  if (platform === 'linux') return 'linux'
  if (platform === 'android' || platform === 'ios' || platform === 'chrome os' || platform === 'chromeos') return null

  // Mobile devices have no matching package even when the UA mentions Linux/Mac.
  if (/Android|iPhone|iPad|iPod|CrOS/i.test(userAgent)) return null
  if (/Windows NT/i.test(userAgent)) return 'win32'
  if (/Mac OS X|Macintosh/i.test(userAgent)) return 'darwin'
  if (/Linux/i.test(userAgent)) return 'linux'
  return null
}

function resolveUaDataArch(architecture: string | undefined, bitness: string | undefined): 'x64' | 'arm64' | null {
  if (!architecture) return null
  if (architecture === 'arm') return 'arm64'
  if (architecture === 'x86' && bitness === '64') return 'x64'
  return null
}

interface UaDataNavigator extends Navigator {
  userAgentData?: {
    platform?: string
    getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string; bitness?: string }>
  }
}

export async function detectBridgePlatformKey(navigatorLike: Navigator = navigator): Promise<string | null> {
  const uaData = (navigatorLike as UaDataNavigator).userAgentData
  let architecture: string | undefined
  let bitness: string | undefined
  if (uaData?.getHighEntropyValues) {
    try {
      const values = await uaData.getHighEntropyValues(['architecture', 'bitness'])
      architecture = values.architecture
      bitness = values.bitness
    } catch {
      // Hints unavailable; fall back to user agent parsing.
    }
  }
  return resolveBridgePlatformKey({
    userAgent: navigatorLike.userAgent,
    uaDataPlatform: uaData?.platform,
    ...(architecture !== undefined ? { uaDataArchitecture: architecture } : {}),
    ...(bitness !== undefined ? { uaDataBitness: bitness } : {})
  })
}

/**
 * Fake download set so the install UI can be previewed in dev when no real
 * bridge build is published. The URLs are inert (`#`).
 */
export function placeholderBridgeDownloads(): BridgeStandaloneDownload[] {
  return ['win32-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-arm64', 'darwin-x64'].map((platformKey) => ({
    platformKey,
    buildRevision: 'devplaceholder',
    releasedAt: '2026-01-01T00:00:00.000Z',
    url: '#',
    fileName: `printstream-bridge-dev-${platformKey}${platformKey.startsWith('win32') ? '.exe' : ''}`,
    sizeBytes: 150_000_000,
    sha256: 'devplaceholder'
  }))
}
