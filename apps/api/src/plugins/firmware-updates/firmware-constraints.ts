/**
 * Bambu Lab firmware-update constraints.
 *
 * PrintStream installs firmware by staging Bambu's offline upgrade package on the
 * printer's SD card; the user then flashes it from the printer screen via
 * Settings > Firmware > Update Offline. Two Bambu-documented limitations can make
 * a staged package non-flashable, and neither is visible from the version list —
 * so we surface them in the update report instead of letting the upload silently
 * lead nowhere:
 *
 * 1. Offline-update floor — a model's on-screen "Update Offline" option only
 *    appears once the *installed* firmware reaches a minimum version. Below it the
 *    printer has to be updated online (Bambu Handy / Bambu Studio) once, so staging
 *    a file over the LAN does nothing.
 * 2. Prerequisite ("stepping-stone") hop — some target versions cannot be flashed
 *    directly from an old enough installed version; an intermediate "bridge" /
 *    "helper" build must be installed first.
 *
 * These are curated facts keyed by the bambulab.com API key (see `resolveApiKey`
 * in `firmware-source.ts`). The tables are meant to grow as Bambu announces new
 * gated releases; the evaluators below stay generic.
 *
 * Sources (Bambu Lab Wiki, verified 2026-06):
 * - Offline floors: per-model "Firmware Upgrade via microSD Card" prerequisites
 *   (P1 >= 01.07.00.00, X1/X1C >= 01.08.02.00, A1/A1 mini >= 01.04.00.00,
 *   X1E >= 01.01.02.00; the H2 series shipped with offline updates).
 * - Hops: per-model firmware release histories — P1 "Bridge Firmware" 01.09.01.00
 *   and X1E "helper firmware" 01.01.50.02.
 */
import { compareVersions } from './firmware-source.js'

/**
 * Minimum installed firmware for a model's on-screen offline-update option, keyed
 * by bambulab.com API key. Models absent here (e.g. `h2d`) have no known floor.
 */
const OFFLINE_UPDATE_FLOORS: Record<string, string> = {
  x1: '01.08.02.00', // X1 / X1C
  x1e: '01.01.02.00', // X1E
  p1: '01.07.00.00', // P1 / P1S / P1P
  a1: '01.04.00.00', // A1 / A2L
  'a1-mini': '01.04.00.00' // A1 mini
}

interface PrerequisiteHop {
  /** Intermediate version that must be installed before jumping past it. */
  requiredVersion: string
  /** Human label Bambu uses for the build, e.g. "Bridge Firmware". */
  label: string
  /**
   * The hop only gates printers whose installed firmware is at or below this
   * version. Defaults to `requiredVersion` (i.e. anything below the intermediate)
   * when omitted; set it explicitly when the documented gate is lower than the
   * intermediate build itself (X1E gates 01.01.02.00-and-earlier behind a
   * 01.01.50.02 helper build).
   */
  currentAtOrBelow?: string
}

/** Known stepping-stone hops by API key (a model may accrue more than one). */
const PREREQUISITE_HOPS: Record<string, PrerequisiteHop[]> = {
  // Anything above 01.09.01.00 requires the 01.09.01.00 "Bridge Firmware" first.
  p1: [{ requiredVersion: '01.09.01.00', label: 'Bridge Firmware' }],
  // 01.02.00.00+ requires the 01.01.50.02 helper build when on 01.01.02.00 or earlier.
  x1e: [{ requiredVersion: '01.01.50.02', label: 'helper firmware', currentAtOrBelow: '01.01.02.00' }]
}

export interface OfflineUpdateEligibility {
  /** Minimum installed firmware required for offline updates, or null when the model has no floor. */
  minimumVersion: string | null
  /**
   * True when the installed firmware is known and below `minimumVersion`: the
   * SD-card flow cannot help, so the printer must be updated online first.
   * Stays false while the installed version is unknown — we never guess a block.
   */
  belowMinimum: boolean
}

/** Whether offline (SD-card) updates are usable on a printer given its installed firmware. */
export function evaluateOfflineUpdate(
  apiKey: string | null,
  currentVersion: string | null
): OfflineUpdateEligibility {
  const minimumVersion = (apiKey ? OFFLINE_UPDATE_FLOORS[apiKey] : undefined) ?? null
  const belowMinimum = Boolean(
    minimumVersion && currentVersion && compareVersions(currentVersion, minimumVersion) < 0
  )
  return { minimumVersion, belowMinimum }
}

export interface FirmwarePrerequisite {
  /** Intermediate firmware version to install before the target. */
  requiredVersion: string
  /** Human label for the intermediate build, e.g. "Bridge Firmware". */
  label: string
}

/**
 * The intermediate firmware (if any) that must be installed before jumping from
 * `currentVersion` straight to `targetVersion` on this model. Returns the nearest
 * required hop, or null when the jump is allowed (or the inputs are unknown).
 */
export function evaluatePrerequisite(
  apiKey: string | null,
  currentVersion: string | null,
  targetVersion: string | null
): FirmwarePrerequisite | null {
  if (!apiKey || !currentVersion || !targetVersion) return null
  const hops = PREREQUISITE_HOPS[apiKey]
  if (!hops) return null

  const applicable = hops.filter((hop) => {
    const ceiling = hop.currentAtOrBelow ?? hop.requiredVersion
    return (
      compareVersions(currentVersion, hop.requiredVersion) < 0 // installed fw is missing the intermediate
      && compareVersions(targetVersion, hop.requiredVersion) > 0 // target jumps past the intermediate
      && compareVersions(currentVersion, ceiling) <= 0 // installed fw is old enough to be gated
    )
  })
  if (applicable.length === 0) return null

  // When several gates apply (chained hops), the lowest intermediate must come first.
  applicable.sort((a, b) => compareVersions(a.requiredVersion, b.requiredVersion))
  const next = applicable[0]!
  return { requiredVersion: next.requiredVersion, label: next.label }
}
