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
import { useQuery } from '@tanstack/react-query'
import {
  prepareResolvedFilamentState,
  resolvedFilamentModifiedKeys,
  resolvedProcessModifiedKeys,
  type ProcessConfig,
  type ResolveFilamentConfigResponse,
  type ResolveProcessConfigResponse
} from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'

const PROJECT_PROFILE_PREFIX = 'project:'

/** Count of filament settings whose final sliced value differs from the external preset. */
export function useFilamentChangedCount(input: {
  slicerTargetId: string
  filamentProfileId: string | null
  sourceFileId: string | null
  projectFilamentId: number
  overrides: ProcessConfig
}): number {
  const enabled = Boolean(
    input.filamentProfileId?.startsWith(PROJECT_PROFILE_PREFIX) && input.sourceFileId && input.slicerTargetId
  )
  const query = useQuery({
    queryKey: ['filament-baked-changes', input.slicerTargetId, input.filamentProfileId, input.sourceFileId, input.projectFilamentId],
    enabled,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const response = await apiFetch<ResolveFilamentConfigResponse>('/api/slicing/profiles/resolve-filament', {
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

/** Count of process settings whose final sliced value differs from the external preset. */
export function useProcessChangedCount(input: {
  slicerTargetId: string
  processProfileId: string | null
  sourceFileId: string | null
  overrides: ProcessConfig
}): number {
  const enabled = Boolean(
    input.processProfileId?.startsWith(PROJECT_PROFILE_PREFIX) && input.sourceFileId && input.slicerTargetId
  )
  const query = useQuery({
    queryKey: ['process-baked-changes', input.slicerTargetId, input.processProfileId, input.sourceFileId],
    enabled,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
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
  return resolvedProcessModifiedKeys(query.data, input.overrides).length
}
