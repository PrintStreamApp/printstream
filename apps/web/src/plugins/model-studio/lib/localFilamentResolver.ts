/**
 * The public 3MF editor's anonymous filament-config resolver — the `resolveConfig` seam the material
 * "tune" dialog and the sidebar's per-material "changed vs preset" badge call to seed a filament's
 * baseline. The filament counterpart of `buildLocalProcessConfigResolver`.
 *
 * Mirrors the tenant `/api/slicing/profiles/resolve-filament` route, split by where the data lives:
 * - BUILT-IN preset -> the anonymous `/api/public/slicing/resolve-filament` endpoint (the slicer
 *   resolves it from its image; no workspace needed).
 * - PROJECT filament (`project:filament:`) -> resolved IN THE BROWSER from the 3MF's own
 *   `project_settings.config` at the filament's SLOT column (via the shared
 *   `extractProjectFilamentConfig`), with the baseline resolved by matching the slot's parent preset
 *   NAME to a built-in in the loaded catalogue and resolving THAT through the public endpoint. This
 *   is exactly what the tenant route does with the file it reads server-side — here the file only
 *   exists in the tab.
 * - CUSTOM/workspace preset -> impossible on an anonymous host; treated as unresolvable.
 *
 * A BUILT-IN preset is also asked about a SLOT, because a slot whose picker names a stock preset can
 * still carry drift baked into the 3MF (this is how a project keeps a raised max volumetric speed
 * while still naming the stock preset). The tenant route reads that from the file server-side; here
 * it comes from the same in-tab archive, so the two hosts report the same badge for the same
 * project instead of the viewer flatly reporting none.
 */
import {
  extractProjectFilamentConfig,
  filamentSlotValuesCarryTo,
  isProjectSlicingPresetId,
  slicingPresetProvenance,
  type ProcessConfig,
  type ResolveFilamentConfigResponse,
  type SlicingPresetSummary
} from '@printstream/shared'
import { apiFetch } from '../../../lib/apiClient'
import type { FilamentConfigResolver } from '../../../components/library/FilamentSettingsDialog'
import { findParentBuiltinPreset } from './localPresetBaseline'
import type { ClientThreeMfProject } from './clientThreeMfProject'

/** The project's own values at a filament slot, read from the in-tab archive. Null when absent. */
function readProjectFilamentSlot(project: ClientThreeMfProject, projectFilamentId: number) {
  const json = project.archive.indexEntries().projectSettingsJson
  if (!json) return null
  try {
    return extractProjectFilamentConfig(JSON.parse(json), projectFilamentId)
  } catch {
    return null
  }
}

/** Resolve a built-in filament preset's config via the anonymous endpoint. Injectable for tests. */
export type BuiltinFilamentResolver = (filamentProfileId: string, targetId: string | null) => Promise<ResolveFilamentConfigResponse>

const resolveBuiltinFilamentViaApi: BuiltinFilamentResolver = (filamentProfileId, targetId) =>
  apiFetch<ResolveFilamentConfigResponse>('/api/public/slicing/resolve-filament', {
    method: 'POST',
    body: { filamentProfileId, targetId }
  })

/**
 * Build the resolver for one open project. `filamentProfiles` is read live (the catalogue loads
 * async), so the caller passes the current list on each call — keep the returned function itself
 * stable at the call site if it feeds an effect.
 */
export function buildLocalFilamentConfigResolver(input: {
  project: ClientThreeMfProject
  filamentProfiles: SlicingPresetSummary[]
  /** Built-in resolver; defaults to the anonymous endpoint. */
  resolveBuiltin?: BuiltinFilamentResolver
}): FilamentConfigResolver {
  const resolveBuiltinFilament = input.resolveBuiltin ?? resolveBuiltinFilamentViaApi
  return async ({ filamentProfileId, targetId, projectFilamentId }) => {
    if (isProjectSlicingPresetId(filamentProfileId)) {
      if (!projectFilamentId || projectFilamentId < 1) throw new Error('Filament profile could not be resolved')
      const project = readProjectFilamentSlot(input.project, projectFilamentId)
      if (!project) throw new Error('Filament profile could not be resolved')
      // Baseline, in order of fidelity: (1) a built-in with the EXACT slot preset name; (2) the
      // built-in PARENT of a workspace custom preset (unavailable here); (3) nothing resolvable ->
      // fall back to the slot's changed-from-system keys. Same three-tier rule as the process
      // resolver — see `buildLocalProcessConfigResolver`.
      let baseline: ResolveFilamentConfigResponse['config'] | null = null
      if (project.presetName) {
        const exact = input.filamentProfiles.find(
          (profile) => profile.kind === 'filament' && profile.name === project.presetName && slicingPresetProvenance(profile.id) === 'builtin'
        )
        const parent = exact ?? findParentBuiltinPreset(input.filamentProfiles, project.presetName, 'filament')
        if (parent) baseline = (await resolveBuiltinFilament(parent.id, targetId)).config
      }
      // The file's declared record rides along in BOTH branches, matching the tenant route: a
      // resolved baseline does not make it redundant, it is what says whether a difference from
      // that baseline was a user's change or drift the vendor would normalize away.
      return baseline
        ? { config: project.config, baseConfig: baseline, overriddenKeys: project.overriddenKeys, declaresOverrides: project.declaresOverrides }
        // No preset resolved: `baseConfig` is a stand-in copy, so only the declared record can say
        // what changed. Flagged explicitly — the payload cannot be told apart from an unmodified
        // project otherwise. Same contract as the tenant route.
        : { config: project.config, baseConfig: project.config, overriddenKeys: project.overriddenKeys, declaresOverrides: project.declaresOverrides, baselineResolved: false }
    }
    if (slicingPresetProvenance(filamentProfileId) === 'builtin') {
      const preset = await resolveBuiltinFilament(filamentProfileId, targetId)
      // ...but only while the slot still holds the same MATERIAL. Pointing a slot at a different
      // material must carry nothing over — see `filamentSlotValuesCarryTo`, which encodes
      // BambuStudio's own rule (`Tab::select_preset` sets `no_transfer` on a filament_type change).
      // An EMPTY slot says nothing — overlaying it would blank the preset the caller asked for.
      const slot = projectFilamentId ? readProjectFilamentSlot(input.project, projectFilamentId) : null
      const slotValues = slot && Object.keys(slot.config).length > 0 ? slot.config : null
      const slotConfig = slotValues && filamentSlotValuesCarryTo(slotValues, preset.config) ? slotValues : null
      if (!slotConfig) return preset
      // Only the DECLARED changes follow the slot onto a different preset (BambuStudio's
      // `Tab::select_preset` carries the dirty options and takes the new preset's value for the
      // rest); without a declared record the whole slot carries, as it always did. Same rule as
      // the tenant route's `/profiles/resolve-filament`, so both hosts agree.
      const declaredCarry = slot?.declaresOverrides
        ? slot.overriddenKeys.reduce<ProcessConfig>((picked, key) => {
            const value = slotConfig[key]
            if (value !== undefined) picked[key] = value
            return picked
          }, {})
        : null
      return {
        ...preset,
        config: declaredCarry ? { ...preset.config, ...declaredCarry } : slotConfig,
        overriddenKeys: slot?.overriddenKeys ?? [],
        declaresOverrides: slot?.declaresOverrides
      }
    }
    throw new Error('Filament profile could not be resolved')
  }
}
