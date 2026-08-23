/**
 * Shared baseline-picking for the public 3MF editor's anonymous resolvers (process + filament).
 *
 * A project that used a workspace CUSTOM preset can't be diffed against that preset on an anonymous
 * host (it doesn't exist here), so we diff against the STANDARD preset it inherits from: the closest
 * resolvable baseline. This finds it by name: the longest built-in of the given kind whose name is a
 * prefix of the custom name AT A WORD BOUNDARY. BambuStudio names a custom preset
 * "<standard> - <suffix>" / "<standard> (n)", so "0.20mm Standard @BBL H2D - Ryan" resolves to
 * "0.20mm Standard @BBL H2D". Null when nothing matches (an entirely renamed preset), which the
 * callers treat as "fall back to the 3MF's own changed-from-system record".
 *
 * WHICH tier a resolver landed on is reported to the dialog as a `SettingsBaselineOrigin`, not
 * re-derived by the host: see `packages/shared/src/settings-baseline.ts`.
 */
import { slicingPresetProvenance, type SlicingPresetSummary } from '@printstream/shared'

export function findParentBuiltinPreset(
  profiles: SlicingPresetSummary[],
  presetName: string,
  kind: SlicingPresetSummary['kind']
): SlicingPresetSummary | null {
  let best: SlicingPresetSummary | null = null
  for (const profile of profiles) {
    if (profile.kind !== kind || slicingPresetProvenance(profile.id) !== 'builtin') continue
    if (profile.name.length >= presetName.length || !presetName.startsWith(profile.name)) continue
    // Only at a word boundary, so "…H2D" never matches "…H2DX".
    if (!/[\s\-(]/.test(presetName.charAt(profile.name.length))) continue
    if (!best || profile.name.length > best.name.length) best = profile
  }
  return best
}
