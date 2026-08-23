/**
 * Whether the import buttons are usable, and, when they are not, the reason to show.
 *
 * Pulled out of `RemoteImportsView` because the enablement rule had silently gone wrong:
 * it allowed only a direct file URL or a picked candidate, so once MakerWorld pages
 * became importable server-side both buttons stayed dead for them with nothing on
 * screen saying why. A disabled control with no reason is the failure mode this module
 * exists to prevent, so `reason` is part of the return value rather than an afterthought
 * at the call site.
 *
 * `reason` is null in exactly two cases: the action is available, or the user has not
 * typed a URL yet (nagging an empty form is noise, and the button's own emptiness is
 * self-explanatory there).
 */
import type { RemoteImportStrategy } from '@printstream/shared'

export interface ImportReadiness {
  /** Import is possible now. */
  canImport: boolean
  /**
   * "Import and print" is worth offering. For a MakerWorld model this is optimistic:
   * whether the downloaded file is printer-ready is only knowable after the download,
   * so the attempt is allowed and the response decides (see `canPrintDirectly`).
   */
  canPrint: boolean
  /** Why the buttons are unavailable, or null when they are available / nothing typed. */
  reason: string | null
}

export function resolveImportReadiness(input: {
  hasUrl: boolean
  hasBridge: boolean
  strategy: RemoteImportStrategy
  /** Message `detectRemoteImportUrl` produced for this URL. */
  resolutionMessage: string
  hasSelectedCandidate: boolean
  /** The selected candidate (or the URL itself) is already a printable file. */
  isDirectPrintable: boolean
  /** Set when the pasted URL names a MakerWorld model. */
  makerWorld: { enabled: boolean; accountConnected: boolean } | null
  /** A provider challenge the user must clear themselves before retrying. */
  requiresManualIntervention: boolean
}): ImportReadiness {
  const blocked = (reason: string): ImportReadiness => ({ canImport: false, canPrint: false, reason })

  if (!input.hasUrl) return { canImport: false, canPrint: false, reason: null }
  if (input.requiresManualIntervention) {
    return blocked('Clear the challenge on the provider site, then try again.')
  }

  if (input.makerWorld) {
    if (!input.makerWorld.enabled) {
      return blocked('MakerWorld imports are turned off for this workspace. Turn them on in the remote imports plugin settings.')
    }
    if (!input.makerWorld.accountConnected) {
      return blocked('Connect a Bambu Lab account for this workspace to import MakerWorld models.')
    }
    if (!input.hasBridge) return blocked('Choose where to save the file first.')
    // Printability is unknown until the file is here, so offer the print path.
    return { canImport: true, canPrint: true, reason: null }
  }

  const importable = input.strategy === 'server-download' || input.hasSelectedCandidate
  if (!importable) {
    return blocked(
      input.strategy === 'browser-assist'
        ? 'PrintStream cannot download from this site on its own yet.'
        : input.resolutionMessage
    )
  }
  if (!input.hasBridge) return blocked('Choose where to save the file first.')

  return {
    canImport: true,
    canPrint: input.isDirectPrintable,
    // Import is fine; only the print half is unavailable, so say what it needs.
    reason: input.isDirectPrintable ? null : 'This file needs slicing before it can be printed, so it can only be imported.'
  }
}
