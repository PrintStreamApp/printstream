/**
 * Web-side derivation of a bridge's crash-health chip from its self-reported
 * crash summary. Wraps the shared {@link deriveBridgeCrashState} with Joy palette
 * colors and user-facing labels so the bridge surfaces read consistently.
 */
import { deriveBridgeCrashState, type BridgeCrashHealth } from '@printstream/shared'

export interface BridgeCrashChip {
  label: string
  /** Joy palette color. */
  color: 'danger' | 'warning'
}

/** A chip describing a bridge's current crash state, or null when it reads healthy. */
export function bridgeCrashChip(crash: BridgeCrashHealth, nowMs: number = Date.now()): BridgeCrashChip | null {
  switch (deriveBridgeCrashState(crash, nowMs)) {
    case 'looping':
      return { label: 'Crash-looping', color: 'danger' }
    case 'unstable':
      return { label: 'Recently crashed', color: 'warning' }
    default:
      return null
  }
}
