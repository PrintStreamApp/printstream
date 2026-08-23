/**
 * The public 3MF editor's anonymous process-config resolver: the `resolveConfig` seam
 * `ProcessSettingsDialog` (and the machine-switch carry-over) call to seed a preset's baseline.
 *
 * Mirrors the workspace `/api/slicing/profiles/resolve-process` route, split by where the data lives:
 * - BUILT-IN preset -> the anonymous `/api/public/slicing/resolve-process` endpoint (the slicer
 *   resolves it from its image; no workspace needed).
 * - PROJECT preset (`project:`) -> resolved IN THE BROWSER from the 3MF's own
 *   `project_settings.config` (via the shared `extractProjectProcessConfig`), with the baseline
 *   resolved by matching the project's parent preset NAME to a built-in in the loaded catalogue and
 *   resolving THAT through the public endpoint. This is exactly what the workspace route does with the
 *   file it reads server-side, here the file only exists in the tab.
 * - BROWSER-STORED preset (`local:process:`) -> the document the user uploaded through the "Manage"
 *   dialog, flattened onto its built-in parent. Same branch the filament resolver grew first
 *   (`localFilamentResolver.ts`): before it, a project that SELECTED a stored process preset
 *   dead-ended the tune dialog on "could not be resolved" while the preset sat visibly in Manage.
 * - WORKSPACE preset -> genuinely impossible here; treated as unresolvable.
 */
import type { SettingsBaselineOrigin } from '@printstream/shared'
import {
  extractProjectProcessConfig,
  isProjectSlicingPresetId,
  slicingPresetProvenance,
  type ResolveProcessConfigResponse,
  type SlicingPresetSummary
} from '@printstream/shared'
import { apiFetch } from '../../../lib/apiClient'
import type { ProcessConfigResolver } from '../../../components/ProcessSettingsDialog'
import { findParentBuiltinPreset } from './localPresetBaseline'
import { flattenLocalPreset } from './localPresetInheritance'
import { listLocalSlicingPresets } from './localSlicingPresets'
import type { ClientThreeMfProject } from './clientThreeMfProject'

/** Resolve a built-in preset's config via the anonymous endpoint. Injectable for tests. */
export type BuiltinProcessResolver = (processProfileId: string, targetId: string | null) => Promise<ResolveProcessConfigResponse>

export const resolveBuiltinProcessViaApi: BuiltinProcessResolver = (processProfileId, targetId) =>
  apiFetch<ResolveProcessConfigResponse>('/api/public/slicing/resolve-process', {
    method: 'POST',
    body: { processProfileId, targetId }
  })

/**
 * Build the resolver for one open project. `processProfiles` is read live (the catalogue loads
 * async), so the caller passes the current list on each call: keep the returned function itself
 * stable at the call site if it feeds an effect.
 */
export function buildLocalProcessConfigResolver(input: {
  project: ClientThreeMfProject
  processProfiles: SlicingPresetSummary[]
  /** Built-in resolver; defaults to the anonymous endpoint. */
  resolveBuiltin?: BuiltinProcessResolver
}): ProcessConfigResolver {
  const resolveBuiltinProcess = input.resolveBuiltin ?? resolveBuiltinProcessViaApi
  return async ({ processProfileId, targetId }) => {
    if (isProjectSlicingPresetId(processProfileId)) {
      const json = input.project.archive.indexEntries().projectSettingsJson
      let parsed: unknown = null
      try {
        parsed = json ? JSON.parse(json) : null
      } catch {
        parsed = null
      }
      const project = extractProjectProcessConfig(parsed)
      if (!project) throw new Error('Process profile could not be resolved')
      // Baseline, in order of fidelity: (1) a built-in with the EXACT preset name (the project used a
      // standard preset): the value-diff is then the project's own edits; (2) the built-in PARENT of
      // a workspace custom preset (unavailable here), so the diff is a complete, value-accurate
      // project-vs-STANDARD set: more than the workspace's project-vs-custom view, and it can't flag
      // an edit whose value equals the standard, but it beats trusting the 3MF's recorded list;
      // (3) nothing resolvable -> fall back to the 3MF's changed-from-system keys.
      let baseline: ResolveProcessConfigResponse['config'] | null = null
      // Which tier we land on changes what a marker MEANS, so it rides back with the config rather
      // than being re-derived by a caller that would have to guess at the same three rules.
      let baselineOrigin: SettingsBaselineOrigin = { kind: 'declared' }
      if (project.presetName) {
        const exact = input.processProfiles.find(
          (profile) => profile.kind === 'process' && profile.name === project.presetName && slicingPresetProvenance(profile.id) === 'builtin'
        )
        const parent = exact ?? findParentBuiltinPreset(input.processProfiles, project.presetName, 'process')
        if (parent) {
          baseline = (await resolveBuiltinProcess(parent.id, targetId)).config
          baselineOrigin = exact ? { kind: 'exact' } : { kind: 'parent', name: parent.name }
        }
      }
      // The file's declared record rides along in BOTH branches, matching the workspace route: a
      // resolved baseline does not make it redundant, it is what says whether a difference from
      // that baseline was a user's change or drift the vendor would normalize away.
      return baseline
        ? { config: project.config, baseConfig: baseline, overriddenKeys: project.overriddenKeys, declaresOverrides: project.declaresOverrides, baselineOrigin }
        // No preset resolved: `baseConfig` is a stand-in copy, so only the declared record can say
        // what changed. Flagged explicitly: the payload cannot be told apart from an unmodified
        // project otherwise. Same contract as the workspace route.
        : { config: project.config, baseConfig: project.config, overriddenKeys: project.overriddenKeys, declaresOverrides: project.declaresOverrides, baselineResolved: false, baselineOrigin }
    }
    if (slicingPresetProvenance(processProfileId) === 'builtin') {
      return resolveBuiltinProcess(processProfileId, targetId)
    }
    // A preset the user uploaded into THIS BROWSER (the "Manage" dialog's store). FLATTENED onto
    // its parent first, a BambuStudio export is a delta, and handing `raw` out directly makes the
    // dialog show a handful of values as the whole preset (see `localPresetInheritance.ts`).
    // Shaped like the workspace route's custom-preset response: an installed preset is what the
    // caller's values are measured AGAINST, so it is its own baseConfig and nothing is "changed"
    // until an edit changes it; the parent's values ride in `parentConfig` as emphasis only.
    const stored = listLocalSlicingPresets().find((preset) => preset.id === processProfileId && preset.kind === 'process')
    if (stored) {
      const { config, parentConfig, parentUnresolved } = await flattenLocalPreset(stored, input.processProfiles,
        async (builtinId) => (await resolveBuiltinProcess(builtinId, targetId)).config ?? null)
      return {
        config,
        baseConfig: config,
        ...(parentConfig ? { parentConfig } : {}),
        // Only when a parent was NAMED and did not resolve: see the filament twin. A self-contained
        // preset is complete, and claiming otherwise is a false statement about the user's own file.
        ...(parentUnresolved ? { baselineOrigin: { kind: 'partial' as const } } : {}),
        overriddenKeys: []
      }
    }
    throw new Error('Process profile could not be resolved')
  }
}
