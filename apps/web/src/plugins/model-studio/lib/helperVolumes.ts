/**
 * The one description of a helper volume (support blocker/enforcer, modifier, negative part):
 * its label, its explanatory hint, and the colour it renders in.
 *
 * Single source of truth on purpose. These volumes appear in four places — the translucent
 * viewport mesh, the added-part panel, the "Add …" context menu, and the sidebar part rows — and
 * the colour used to be duplicated across two tables, so the SAME support blocker rendered one red
 * while it was a session-added part and a different red once a save turned it into a real
 * `<component>`. Everything now reads its colour from here.
 *
 * Blocker and enforcer match BambuStudio exactly (`GLVolume::SUPPORT_BLOCKER_COL` /
 * `SUPPORT_ENFORCER_COL` in `src/slic3r/GUI/3DScene.cpp`). Modifier and negative deliberately do
 * not: BambuStudio paints them yellow and near-black, which read as a warning and as a hole
 * against our dark viewport. Ours stay distinguishable instead.
 */
import { canonicalThreeMfPartSubtype, type SceneEditAddedPartSubtype } from '@printstream/shared'

export interface HelperVolumeSpec {
  label: string
  /** Rendered translucent in the viewport and as a solid chip in the panels. */
  color: number
  hint: string
}

export const HELPER_VOLUME_SPECS: Record<SceneEditAddedPartSubtype, HelperVolumeSpec> = {
  negative_part: { label: 'Negative part', color: 0xcfd4dc, hint: 'Its shape is cut out of the model when slicing.' },
  modifier_part: { label: 'Modifier', color: 0x9aa0b3, hint: 'Apply per-object process overrides inside its volume.' },
  support_blocker: { label: 'Support blocker', color: 0xff4d4d, hint: 'Supports are never generated inside its volume.' },
  support_enforcer: { label: 'Support enforcer', color: 0x4d4dff, hint: 'Supports are always generated inside its volume.' }
}

export const HELPER_VOLUME_SUBTYPES = Object.keys(HELPER_VOLUME_SPECS) as SceneEditAddedPartSubtype[]

/**
 * The spec for a RAW 3MF subtype string, or null for a normal printed part. Callers must use this
 * rather than truthiness of the subtype: Bambu marks ordinary parts `subtype="normal_part"`, so a
 * present subtype does not imply a helper volume.
 */
export function helperVolumeSpec(subtype: string | null | undefined): HelperVolumeSpec | null {
  const canonical = canonicalThreeMfPartSubtype(subtype)
  return canonical === 'normal_part' ? null : HELPER_VOLUME_SPECS[canonical]
}

/** `#rrggbb` for a spec colour, for CSS/Joy `bgcolor`. */
export function helperVolumeCssColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}
