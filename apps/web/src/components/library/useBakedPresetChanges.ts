/**
 * Pre-open "changed values" badges for the slice dialog's preset rows.
 *
 * Owns the lazy resolve queries behind the tune buttons in `SliceSettingsPanel`: for a
 * PROJECT-embedded process/filament profile, fetch its resolved config once (React Query cached)
 * and count how far the FINAL sliced values (embedded config + the session's overrides) differ
 * from the external preset — via the shared `resolvedProcessModifiedKeys` /
 * `resolvedFilamentModifiedKeys`, the same math the settings dialogs flag with, so badge and
 * dialog can never disagree. Healing property: overrides that reset a drifted value back to the
 * preset REDUCE the count (a fully reset material reads 0 even though heal overrides ride the
 * slice request).
 *
 * Installed presets (builtin/custom) cannot differ from themselves, so no fetch happens; the
 * count falls back to the session override count.
 */
import { useQueries, useQuery } from '@tanstack/react-query'
import {
  prepareResolvedFilamentState,
  resolvedFilamentModifiedKeys,
  resolvedVisibleProcessModifiedKeys,
  type ProcessConfig,
  type ProcessVisibilityContext,
  type ResolveFilamentConfigResponse,
  type ResolveProcessConfigResponse
} from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import type { ProcessConfigResolver } from '../ProcessSettingsDialog'
import type { FilamentConfigResolver } from './FilamentSettingsDialog'

const PROJECT_PROFILE_PREFIX = 'project:'

/** Count of filament settings whose final sliced value differs from the external preset. */
export function useFilamentChangedCount(input: {
  slicerTargetId: string
  filamentProfileId: string | null
  sourceFileId: string | null
  projectFilamentId: number
  overrides: ProcessConfig
  /**
   * Anonymous resolver (public 3MF editor). When present the baseline is resolved through it rather
   * than the tenant route — and WITHOUT requiring a server `sourceFileId`, since it reads the project
   * filament's slot from the in-tab 3MF. Absent → the tenant route as before.
   */
  resolveConfig?: FilamentConfigResolver
}): number {
  // Resolved for EVERY preset kind, not just project-embedded ones. The old fallback counted
  // override KEYS for an installed preset, which is not the same question: resetting a drifted
  // value emits a heal override (the dialog writes the preset's value rather than deleting the
  // key), so a fully reset material showed a badge over a dialog reporting nothing changed. The
  // count has to compare VALUES to have the healing property the header promises.
  const enabled = Boolean(input.filamentProfileId)
    && Boolean(input.slicerTargetId)
    && Boolean(input.resolveConfig || input.sourceFileId || !input.filamentProfileId?.startsWith(PROJECT_PROFILE_PREFIX))
  const query = useQuery({
    queryKey: ['filament-baked-changes', input.slicerTargetId, input.filamentProfileId, input.sourceFileId, input.projectFilamentId, Boolean(input.resolveConfig)],
    enabled,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const response = input.resolveConfig
        ? await input.resolveConfig({
            filamentProfileId: input.filamentProfileId as string,
            targetId: input.slicerTargetId || null,
            sourceFileId: input.sourceFileId,
            projectFilamentId: input.projectFilamentId
          })
        : await apiFetch<ResolveFilamentConfigResponse>('/api/slicing/profiles/resolve-filament', {
            method: 'POST',
            body: {
              filamentProfileId: input.filamentProfileId,
              targetId: input.slicerTargetId || null,
              sourceFileId: input.sourceFileId,
              projectFilamentId: input.projectFilamentId
            },
            signal
          })
      return prepareResolvedFilamentState(response)
    }
  })
  if (!enabled || !query.data) return Object.keys(input.overrides).length
  return resolvedFilamentModifiedKeys(query.data, input.overrides).length
}

/**
 * Which project-embedded filament presets say nothing the installed preset of the same name does not.
 *
 * A 3MF stores a full SNAPSHOT of every value plus the preset name it came from (BambuStudio's
 * `_add_project_config_file_to_archive` writes the resolved config, not a reference), so a
 * bone-stock project still carries a complete config. BambuStudio reconciles the two on load and
 * shows the SYSTEM preset when they agree, dirty when they do not; we instead minted a project
 * preset unconditionally, so every material read as bespoke. Callers drop the ids returned here
 * from the catalogue, which lands the slot on the installed preset the way BambuStudio does.
 *
 * Compared with NO session overrides on purpose: the question is whether the FILE differs from the
 * preset, not whether the user has since changed something — that is the badge's question, and it
 * shares this query's cache rather than refetching.
 *
 * Caveat worth knowing: "unchanged" is judged over the keys our catalogue models. A 3MF carrying a
 * key we do not model would read as unchanged here where BambuStudio, comparing whole configs,
 * would call it dirty. The same comparison already backs the badge and the settings dialog.
 */
export function useUnchangedProjectFilamentPresetIds(input: {
  slicerTargetId: string
  sourceFileId: string | null
  /** One entry per project preset — the FIRST slot that names it, matching how the preset is minted. */
  presets: Array<{ filamentProfileId: string; projectFilamentId: number }>
  resolveConfig?: FilamentConfigResolver
}): Set<string> {
  const canResolve = Boolean(input.slicerTargetId) && Boolean(input.resolveConfig || input.sourceFileId)
  const results = useQueries({
    queries: input.presets.map((preset) => ({
      // Deliberately the SAME key the per-material badge uses, so the two share one fetch.
      queryKey: ['filament-baked-changes', input.slicerTargetId, preset.filamentProfileId, input.sourceFileId, preset.projectFilamentId, Boolean(input.resolveConfig)],
      enabled: canResolve,
      staleTime: 60_000,
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const response = input.resolveConfig
          ? await input.resolveConfig({
              filamentProfileId: preset.filamentProfileId,
              targetId: input.slicerTargetId || null,
              sourceFileId: input.sourceFileId,
              projectFilamentId: preset.projectFilamentId
            })
          : await apiFetch<ResolveFilamentConfigResponse>('/api/slicing/profiles/resolve-filament', {
              method: 'POST',
              body: {
                filamentProfileId: preset.filamentProfileId,
                targetId: input.slicerTargetId || null,
                sourceFileId: input.sourceFileId,
                projectFilamentId: preset.projectFilamentId
              },
              signal
            })
        return prepareResolvedFilamentState(response)
      }
    }))
  })
  const unchanged = new Set<string>()
  results.forEach((result, index) => {
    const preset = input.presets[index]
    if (!preset || !result.data) return
    if (resolvedFilamentModifiedKeys(result.data, {}).length === 0) unchanged.add(preset.filamentProfileId)
  })
  return unchanged
}

/** Count of process settings whose final sliced value differs from the external preset. */
export function useProcessChangedCount(input: {
  slicerTargetId: string
  processProfileId: string | null
  sourceFileId: string | null
  overrides: ProcessConfig
  /**
   * Anonymous resolver (public 3MF editor). When present the baseline is resolved through it rather
   * than the tenant route — and WITHOUT requiring a server `sourceFileId`, since it reads a project
   * preset from the in-tab 3MF. Absent → the tenant route as before.
   */
  resolveConfig?: ProcessConfigResolver
  /**
   * The dialog's visibility inputs, so the badge counts exactly the rows the dialog would show —
   * a conditionally-hidden modified setting must not inflate the badge (see
   * `resolvedVisibleProcessModifiedKeys`).
   */
  visibilityContext?: Partial<ProcessVisibilityContext>
  developerMode?: boolean
}): number {
  const isProjectPreset = Boolean(input.processProfileId?.startsWith(PROJECT_PROFILE_PREFIX))
  // A project preset can differ from its parent; a builtin/custom can't differ from itself, so it
  // never fetches. The tenant path needs a server file; the resolver path reads the in-tab archive.
  const enabled = isProjectPreset && Boolean(input.slicerTargetId) && Boolean(input.resolveConfig || input.sourceFileId)
  const query = useQuery({
    queryKey: ['process-baked-changes', input.slicerTargetId, input.processProfileId, input.sourceFileId, Boolean(input.resolveConfig)],
    enabled,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      if (input.resolveConfig) {
        return await input.resolveConfig({ processProfileId: input.processProfileId as string, targetId: input.slicerTargetId || null, sourceFileId: input.sourceFileId })
      }
      return await apiFetch<ResolveProcessConfigResponse>('/api/slicing/profiles/resolve-process', {
        method: 'POST',
        body: {
          processProfileId: input.processProfileId,
          targetId: input.slicerTargetId || null,
          sourceFileId: input.sourceFileId
        },
        signal
      })
    }
  })
  if (!enabled || !query.data) return Object.keys(input.overrides).length
  return resolvedVisibleProcessModifiedKeys(query.data, input.overrides, {
    ...(input.visibilityContext ? { visibilityContext: input.visibilityContext } : {}),
    developerMode: input.developerMode === true
  }).length
}
