/**
 * The public 3MF editor's anonymous process-config resolver — the `resolveConfig` seam
 * `ProcessSettingsDialog` (and the machine-switch carry-over) call to seed a preset's baseline.
 *
 * Mirrors the tenant `/api/slicing/profiles/resolve-process` route, split by where the data lives:
 * - BUILT-IN preset -> the anonymous `/api/public/slicing/resolve-process` endpoint (the slicer
 *   resolves it from its image; no workspace needed).
 * - PROJECT preset (`project:`) -> resolved IN THE BROWSER from the 3MF's own
 *   `project_settings.config` (via the shared `extractProjectProcessConfig`), with the baseline
 *   resolved by matching the project's parent preset NAME to a built-in in the loaded catalogue and
 *   resolving THAT through the public endpoint. This is exactly what the tenant route does with the
 *   file it reads server-side — here the file only exists in the tab.
 * - CUSTOM/workspace preset -> impossible on an anonymous host; treated as unresolvable.
 */
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
import type { ClientThreeMfProject } from './clientThreeMfProject'

/** Resolve a built-in preset's config via the anonymous endpoint. Injectable for tests. */
export type BuiltinProcessResolver = (processProfileId: string, targetId: string | null) => Promise<ResolveProcessConfigResponse>

const resolveBuiltinProcessViaApi: BuiltinProcessResolver = (processProfileId, targetId) =>
  apiFetch<ResolveProcessConfigResponse>('/api/public/slicing/resolve-process', {
    method: 'POST',
    body: { processProfileId, targetId }
  })

/**
 * Build the resolver for one open project. `processProfiles` is read live (the catalogue loads
 * async), so the caller passes the current list on each call — keep the returned function itself
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
      // standard preset) — the value-diff is then the project's own edits; (2) the built-in PARENT of
      // a workspace custom preset (unavailable here), so the diff is a complete, value-accurate
      // project-vs-STANDARD set — more than the workspace's project-vs-custom view, and it can't flag
      // an edit whose value equals the standard, but it beats trusting the 3MF's recorded list;
      // (3) nothing resolvable -> fall back to the 3MF's changed-from-system keys.
      let baseline: ResolveProcessConfigResponse['config'] | null = null
      if (project.presetName) {
        const exact = input.processProfiles.find(
          (profile) => profile.kind === 'process' && profile.name === project.presetName && slicingPresetProvenance(profile.id) === 'builtin'
        )
        const parent = exact ?? findParentBuiltinPreset(input.processProfiles, project.presetName, 'process')
        if (parent) baseline = (await resolveBuiltinProcess(parent.id, targetId)).config
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
    if (slicingPresetProvenance(processProfileId) === 'builtin') {
      return resolveBuiltinProcess(processProfileId, targetId)
    }
    throw new Error('Process profile could not be resolved')
  }
}
