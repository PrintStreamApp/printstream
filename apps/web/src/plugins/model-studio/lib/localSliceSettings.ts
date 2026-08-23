/**
 * A slice-settings controller for a host with no server behind it.
 *
 * The library builds its controller inside `SliceFileModal` from live workspace data: printers,
 * AMS trays, the workspace's custom presets, slice dispatch. The public editor has none of that, but it
 * DOES need the half of the controller that is about the project itself: which slicer target, which
 * printer model and nozzle, which process and filament presets, and the project's materials.
 *
 * So this is deliberately REDUCED rather than a stub of all 81 fields. The printer, AMS-tray, and
 * slice-dispatch fields are present because the type requires them, but inert, and every surface
 * that would render them is already hidden: `SliceSettingsPanel` drops the Plate and Objects
 * sections in `editor` mode, and now hides the printer picker when there are no printers. Nothing
 * here renders a control that cannot work.
 *
 * Presets come from two places, matching what the host can actually reach: the built-in catalogue
 * from `/api/public/slicing/profiles`, and the user's own uploads from browser storage
 * (`localSlicingPresets.ts`). Signed in, presets remain workspace-stored and this file is unused.
 */
import type { SlicingPresetSummary } from '@printstream/shared'
import type { LocalSlicingPreset } from './localSlicingPresets'

/** What the public host can supply about a project's slicing setup. */
export interface LocalSliceSettingsInput {
  /** Built-in presets from the public catalogue, plus the user's browser-stored ones. */
  profiles: SlicingPresetSummary[]
  /** The user's uploads, kept separately so the settings UI can offer to remove them. */
  localProfiles: LocalSlicingPreset[]
  /** Slicer target the catalogue was fetched for. */
  slicerTargetId: string
}

/**
 * Merge the user's browser-stored presets into a catalogue, so the pickers show both.
 *
 * A local preset SHADOWS a built-in of the same kind and name: the user uploading a preset called
 * "0.20mm Standard" means theirs, and showing two entries with one name would make the choice
 * arbitrary. This mirrors how the api merges a workspace's custom presets over the built-ins.
 */
export function mergeLocalProfilesIntoCatalogue(
  builtin: SlicingPresetSummary[],
  local: LocalSlicingPreset[]
): SlicingPresetSummary[] {
  if (local.length === 0) return builtin
  const shadowed = new Set(local.map((profile) => `${profile.kind}:${profile.name}`))
  const localSummaries = local.map((profile) => toSummary(profile))
  return [...localSummaries, ...builtin.filter((profile) => !shadowed.has(`${profile.kind}:${profile.name}`))]
}

/**
 * Present a browser-stored preset the way the pickers expect.
 *
 * `source: 'custom'` is the same marking the api gives a workspace's uploads, so every surface that
 * already distinguishes custom from built-in keeps working without knowing where it was stored.
 */
function toSummary(profile: LocalSlicingPreset): SlicingPresetSummary {
  return {
    id: profile.id,
    source: 'custom',
    kind: profile.kind,
    name: profile.name,
    updatedAt: profile.addedAt,
    // Inheritance metadata is resolved against the catalogue by whoever consumes it; a stored
    // preset carries only what its own document states.
    inherits: typeof profile.raw.inherits === 'string' ? profile.raw.inherits : null
  } as SlicingPresetSummary
}
